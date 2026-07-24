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
from dotenv import load_dotenv
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
# 0. .env ファイルから環境変数を読み込む（OPENAI_API_KEY など）
# ------------------------------------------------------------------
load_dotenv()

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


# ------------------------------------------------------------------
# 4. システムプロンプト（AI の人格・回答ルールを固定する）
# ------------------------------------------------------------------
system_prompt = """
# 指示
あなたは「〇〇薬局」の薬剤師アシスタントとして、親切・丁寧・正確にお客様の質問に回答します。
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
            # 2-1) Ephemeral Key 取得: /v1/realtime/client_secrets
            #    2026年6月頃に旧beta版 /v1/realtime/sessions が廃止され、GA版のこのエンドポイントに移行。
            #    セッション設定は "session" オブジェクトにネストし、音声関連設定は "audio.input" / "audio.output" 配下に移動。
            # https://platform.openai.com/docs/guides/realtime-webrtc
            ephemeral_resp = await client.post(
                "https://api.openai.com/v1/realtime/client_secrets",
                headers={
                    "Authorization": f"Bearer {os.getenv('OPENAI_API_KEY')}",
                },
                json={
                    "session": {
                        "type": "realtime",
                        "model": "gpt-realtime-2.1-mini",
                        "instructions": system_prompt,
                        "audio": {
                            "input": {
                                "transcription": {
                                    "model": "whisper-1",
                                    "language": "ja",
                                },
                                "turn_detection": {
                                    "type": "server_vad",
                                    "create_response": True,
                                    "threshold": 0.8,
                                    "silence_duration_ms": 1000,
                                },
                            },
                            "output": {
                                "voice": "shimmer",
                            },
                        },
                        "max_output_tokens": 1000,
                    },
                },
                timeout=10,
            )
            ephemeral_resp.raise_for_status()
            ephemeral_key = ephemeral_resp.json().get("value") # エフェメラルキーはレスポンス直下の "value"
            if not ephemeral_key: # キーが存在しない場合は 500 を返して処理を中断
                raise HTTPException(status_code=500, detail="No ephemeral key in response")
            logging.info("Successfully received ephemeral key.")

            # 2-2) Offer SDP を送信し Answer SDP 取得（SDP交換エンドポイントも /v1/realtime/calls に変更）
            sdp_resp = await client.post(
                "https://api.openai.com/v1/realtime/calls",
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


# ------------------------------------------------------------------
# 7. RAG 検索関数 (appRAG) と補助ロジック
# ------------------------------------------------------------------
#    OpenAI Embedding ➜ 類似度計算 ➜ 回答候補抽出
# ------------------------------------------------------------------
# a) 質問 → ベクトル化 → 類似検索