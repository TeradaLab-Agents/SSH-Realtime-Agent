# =============================================================
# 役割:
#   • フロントエンドからの SDP Offer を OpenAI Realtime API に中継
#   • 関数呼び出し(Function Calling)を WebSocket で受信し実行
#   • RAG ベースの検索関数 (appRAG) を提供
# =============================================================
import os
import httpx
import logging
import json
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, constr, ValidationError

import argparse
import pandas as pd
import numpy as np
import tqdm
from openai import OpenAI
from sklearn.metrics.pairwise import cosine_similarity
from openpyxl.styles import Alignment
from openpyxl import load_workbook

# ------------------------------------------------------------------
# 1. ロギング設定
# ------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
)

# ------------------------------------------------------------------
# 2. FastAPI アプリ & CORS ミドルウェアの設定（フロントエンドからのアクセスを許可）
# ------------------------------------------------------------------
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # すべてのオリジンを許可（本番環境では限定すべき）
    allow_credentials=True,
    allow_methods=["*"], # すべてのHTTPメソッドを許可
    allow_headers=["*"], # すべてのヘッダーを許可
)

# ------------------------------------------------------------------
# 3. Function Calling 用ツール定義
#
# https://note.com/vitaactiva/n/ncee4997bbb63
# ------------------------------------------------------------------
tool_app_rag = {
    "type": "function",
    "name": "appRAG",
    # "description": "○○薬局のQ&Aデータベースを検索し、ユーザーの質問に合致する回答を見つけます。ユーザーの口語的な質問から、検索に最適化された簡潔な質問文を生成して引数として使用します。",
    "description": "○○薬局のQ&Aデータベースを検索し、ユーザーの質問に合致する回答を見つけます。",
    "parameters": {
        "type": "object",
        "properties": {
            "search_query": {
                "type": "string",
                # "description": "検索に使用する、ユーザーの質問の意図を正確に反映した、正規化された日本語の質問文。"
                # "description": "ユーザーが入力した、加工されていない、そのままの質問文。文脈全体を使って検索するため、要約やキーワード化は不要です。"
                "description": "ユーザーの質問の意図を正確に捉え、検索精度を高めるために、より明確で具体的、かつ詳細な質問文に書き換えたもの。元の質問の文脈やニュアンスは維持すること。",
            }
        },
        "required": ["search_query"],
    },
}

# ------------------------------------------------------------------
# 4. システムプロンプト（AI の人格・回答ルールを固定する）
# ------------------------------------------------------------------
system_prompt = """
# 指示
あなたは「〇〇薬局」の薬剤師アシスタントとして、親切・丁寧・正確にお客様の質問に回答します。

# ルール
- 回答は必ず`appRAG`関数で得た情報のみに基づき、自己の知識や推測は使用禁止です。
- `appRAG`で情報が見つからない場合、「考え中です。」と回答してください。
- 医療相談や診断に関する質問には、決して自分で判断せず、次の通りに回答し電話を促してください：「その件については専門の薬剤師が直接ご説明しますので、お手数ですがお電話ください。」
"""

# ------------------------------------------------------------------
# 5. SDP Offer/Answer 中継エンドポイント
# ------------------------------------------------------------------
#    URL: POST /api/realtime-proxy
#    フロントから SDP Offer を受信 ➜ OpenAI API へ中継 ➜ 取得した Answer SDP をそのままクライアントへ返却
# ------------------------------------------------------------------
@app.post("/api/realtime-proxy")
async def realtime_proxy(request: Request):
    try:
        # 1) フロントから Offer SDP を受信
        offer_sdp = (await request.body()).decode('utf-8')
        logging.info(f"Received Offer SDP (first 50 chars): {offer_sdp[:50]}...")

        # 2) OpenAI Realtime セッション確立 & SDP 交換
        async with httpx.AsyncClient() as client:
            # 2-1) Ephemeral Key 取得: /v1/realtime/sessions
            # https://note.com/npaka/n/nf9cab7ea954e
            # https://platform.openai.com/docs/api-reference/realtime-sessions/create
            ephemeral_resp = await client.post(
                "https://api.openai.com/v1/realtime/sessions",
                headers={
                    "Authorization": f"Bearer {os.getenv('OPENAI_API_KEY')}",
                    "OpenAI-Beta": "realtime=v1",
                },
                json={
                    "model": "gpt-4o-mini-realtime-preview-2024-12-17",
                    "instructions": system_prompt,
                    "voice": "shimmer",
                    "input_audio_transcription": {
                        "model": "whisper-1",
                        "language": "ja",
                    },
                    "turn_detection": {
                        "type": "server_vad",
                        "create_response": True,
                        "threshold": 0.8,
                        "silence_duration_ms": 1000,
                    },
                    "tools": [tool_app_rag],
                    "temperature": 0.8,
                    "max_response_output_tokens": 500,
                },
                timeout=10,
            )
            ephemeral_resp.raise_for_status()
            ephemeral_key = ephemeral_resp.json().get("client_secret", {}).get("value") # エフェメラルキー(client_secret)を JSON から抽出
            if not ephemeral_key: # キーが存在しない場合は 500 を返して処理を中断
                raise HTTPException(status_code=500, detail="No ephemeral key in response")
            logging.info("Successfully received ephemeral key.")

            # 2-2) Offer SDP を送信し Answer SDP 取得
            sdp_resp = await client.post(
                "https://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview-2024-12-17",
                headers={
                    "Authorization": f"Bearer {ephemeral_key}",
                    "Content-Type": "application/sdp",
                },
                content=offer_sdp,
                timeout=10,
            )
            sdp_resp.raise_for_status()
            answer_sdp = sdp_resp.text
            logging.info(f"Successfully received Answer SDP (length: {len(answer_sdp)}). Sending to client.")

            # 2-3) フロントへ返送
            return PlainTextResponse(content=answer_sdp)

    except httpx.HTTPStatusError as e:
        logging.error(f"HTTP error contacting OpenAI: {e.response.status_code} - {e.response.text}")
        raise HTTPException(status_code=e.response.status_code, detail=e.response.text)
    except Exception:
        logging.exception("Unexpected error in /api/realtime-proxy")
        raise HTTPException(status_code=500, detail="Error in /api/realtime-proxy")

# ------------------------------------------------------------------
# 6. Function Calling 実行 WebSocket エンドポイント
# ------------------------------------------------------------------
#    URL: /ws/function-call
#    フロント ➜ 関数呼び出し ➜ 実行結果を返す
# ------------------------------------------------------------------
@app.websocket("/ws/function-call")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept() # 接続確立
    logging.info("WebSocket connection established for function calling.")
    try:
        while True:
            # 1) 関数呼び出しリクエストを待受
            data = json.loads(await websocket.receive_text())
            call_id = data.get("call_id")
            function_name = data.get("name")
            arguments_str = data.get("arguments")

            # 2) 関数名をルックアップ
            if function_name in AVAILABLE_FUNCTIONS:
                try:
                    # 2‑1) 引数を JSON で検証（引数の“設計図”に基づき、型と制約をチェック）
                    arguments = json.loads(arguments_str)
                    schema = FUNCTION_SCHEMAS[function_name]
                    validated_args = schema(**arguments)

                    # 2‑2) 対応関数を実行（appRAG(search_query="薬を飲み忘れたときは？") の形で関数に渡る）
                    result = AVAILABLE_FUNCTIONS[function_name](**validated_args.dict())

                    # 2-3) 成功レスポンス送信
                    await websocket.send_json({
                        "status": "success",
                        "call_id": call_id,
                        "result": result,
                    })
                    logging.info(f"Executed function '{function_name}' successfully.")

                except ValidationError as e:
                    msg = f"Invalid arguments for {function_name}: {e}"
                    logging.error(msg)
                    await websocket.send_json({"status": "error", "call_id": call_id, "message": msg})
                except Exception as e:
                    msg = f"Execution failed for {function_name}: {e}"
                    logging.error(msg)
                    await websocket.send_json({"status": "error", "call_id": call_id, "message": msg})
            else:
                # g) 未知の関数
                msg = f"Unknown function requested: {function_name}"
                logging.warning(msg)
                await websocket.send_json({"status": "error", "call_id": call_id, "message": msg})

    except WebSocketDisconnect:
        logging.info("Client disconnected from WebSocket.")
    except Exception as e:
        logging.error(f"WebSocket error: {e}", exc_info=True)

# ------------------------------------------------------------------
# 7. RAG 検索関数 (appRAG) と補助ロジック
# ------------------------------------------------------------------
#    OpenAI Embedding ➜ 類似度計算 ➜ 回答候補抽出
# ------------------------------------------------------------------
# a) 質問 → ベクトル化 → 類似検索
def appRAG(search_query: str) -> str:
    logging.info(f"Executing appRAG for: {search_query}")

    print("--- 類似度検索の実行例 ---")
    app_rag_answer = NewQuestion2vector2answer02(
        # question="余った薬はどうしましょう？",
        question=search_query,
        excel_path="./data/QAlist.xlsx",
        npz_path="faq_vectors.npz",
        top_n=3
    )

    # return f"「{search_query}」に関する質問は、データベースが未実装のため回答できません。"
    # return f"営業時間は午前9時から午後10時までです。"
    return app_rag_answer

# b) 入力検証 (Pydantic)
class AppRagArgs(BaseModel):
    search_query: constr(max_length=400)

# c) 関数ディスパッチャ
AVAILABLE_FUNCTIONS = {"appRAG": appRAG}
FUNCTION_SCHEMAS = {"appRAG": AppRagArgs}

# ------------------------------------------------------------------
# 8. Embedding & 類似ドキュメント検索ユーティリティ
# ------------------------------------------------------------------
api_key = os.getenv('OPENAI_API_KEY')
client = OpenAI(api_key=api_key)

def get_embedding(text: str) -> np.ndarray:
    # テキストを OpenAI Embedding API で 1536 次元ベクトルに変換
    response = client.embeddings.create(model="text-embedding-3-small", input=text)
    return np.array(response.data[0].embedding)

def NewQuestion2vector2answer02(question: str, excel_path: str, npz_path: str, top_n: int):
    """
    質問文に類似した QA を検索し、上位 top_n 件の回答テキストを返す。
    """
    # 1) 質問 -> ベクトル
    query_vector = get_embedding(question).reshape(1, -1)

    # 2) 事前計算済み埋め込み行列 & 元データ読み込み
    data = np.load(npz_path)
    df = pd.read_excel(excel_path)

    # 3) 類似度計算 & 上位N件抽出
    similarities = cosine_similarity(query_vector, data["embeddings"]).flatten()
    top_indices = np.argsort(similarities)[::-1][:top_n]

    print(f"\n--- 入力質問: {question} ---\n--- 上位{top_n}件の類似結果 ---\n")

    # 4) 回答テキスト収集
    answer_texts = []
    for rank, idx in enumerate(top_indices, start=1):
        matched_qaid = int(data["qaids"][idx])
        similarity = similarities[idx]
        matched_row = df[df["QAID"] == matched_qaid]

        if not matched_row.empty:
            q_text = matched_row["質問・相談事項"].values[0]
            a_text = matched_row["返答・対応"].values[0]
            
            logging.info(f"【Rank {rank}】QAID: {matched_qaid} (類似度: {similarity:.4f})")
            logging.info(f"  質問: {q_text}")
            logging.info(f"  回答: {a_text}\n" + "-"*30)

            answer_texts.append(a_text)

    return answer_texts