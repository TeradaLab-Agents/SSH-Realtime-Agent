/*********************************************************************************************
 * -------------------------------------------------------------------------------------------
 * このファイルは薬局デモアプリ用のフロントエンドスクリプトです。
 *   1. WebRTC でブラウザのマイク音声をリアルタイムにバックエンドへ送信し、
 *   2. OpenAI Real‑time API からストリーミングで返却されるテキスト／音声／ツールコール
 *      を RTCDataChannel 経由で受信
 *   3. Live2D アバター（Misaki）と同期させて“しゃべるキャラクター”を実現しています。
 *
 * ────────────────────────────────────────────────────────────────
 * ■ システム全体の流れ
 *  ➊ ページ読み込み → UI 初期化
 *  ➋ 「おはなしをはじめる」ボタンクリック
 *      ├─ getUserMedia でマイク取得
 *      ├─ RTCPeerConnection を生成
 *      ├─ DataChannel("oai-events") を開設 【★ 以降ここ経由で OpenAI からイベント受信】
 *      ├─ Offer SDP を BE プロキシへ POST → Answer を受信
 *      └─ PeerConnection 成立・音声ストリーム開始 → UI を "active" 状態に
 *  ➌ 会話中
 *      ├─ DataChannel で逐次イベントを受信
 *      │     ├─ conversation.item.input_audio_transcription.completed → ユーザ吹き出し表示
 *      │     ├─ response.content_part.added                    → 口パク開始
 *      │     ├─ response.output_item.added / done              → Function Calling 準備
 *      │     ├─ output_audio_buffer.stopped                    → 口パク終了
 *      │     └─ response.done                                  → AI 吹き出し表示
 *      └─ Function‑Call WebSocket
 *             ├─ モデルが関数呼び出しイベントを送信
 *             ├─ バックエンドで関数実行 → 結果を WebSocket で受信
 *             └─ 結果を DataChannel へ返却 → モデルに続きを生成させる
 *  ➌ 接続切断／エラー → UI リセット
 *
 * ────────────────────────────────────────────────────────────────
 * Real‑time API 関連で覚えておきたいポイント
 * -------------------------------------------------------------------------------------------
 * ● DataChannel("oai-events")
 *     OpenAI 側がピア接続内で生成し、着信するイベントを JSON で受け取ります。
 *     イベント種別は `msg.type` に入り、switch 文で一元管理。
 *
 * ● response.content_part.added / output_audio_buffer.stopped
 *     モデルが TTS 音声ストリームを開始・停止するタイミング。
 * 　　Live2D アバターの口パク (`Agent.startAgentSpeak / stopAgentSpeak`) と
 *     音声波形アニメーション (`voiceWaves`) を同期。
 *
 * ● Function Calling
 *     - モデルがツールを呼び出すと `response.output_item.added` →
 *       `response.function_call_arguments.delta`（複数回）→ `response.output_item.done`
 *       という順でイベントが飛んできます。
 *     - 引数は複数チャンクに分割して届くため、`pendingCalls` 連想配列でバッファリング。
 *     - 完了後、バックエンドへ WebSocket で JSON を送信し、
 *       その結果を `conversation.item.create` でモデルへ返します。
 *
 * *******************************************************************************************/

// -----------------------------
// DOMContentLoaded: 初期化ブロック
// -----------------------------
document.addEventListener("DOMContentLoaded", () => {
    // ---------------------------------------------------------------------
    // 1.  UI要素の取得
    //
    // 画面に存在する要素をあらかじめキャッシュし、再度 DOM 検索を行わずに高速にアクセス
    // ---------------------------------------------------------------------
    const overlay = document.getElementById("overlay");
    const overlayText = document.getElementById("overlay-text");
    const startPopup = document.getElementById("start-popup");
    const primaryButton = document.getElementById("primary-action-btn");
    const buttonContainerPopup = document.getElementById("button-container-popup");
    const buttonContainerMain = document.getElementById("button-container-main");
    const agentVisibleFlag = document.getElementById("agent_visible_flag");
    const voiceWaves = document.getElementById("voiceWaves");
    const statusText = document.getElementById("statusText");

    // ---------------------------------------------------------------------
    // 2.  グローバル変数
    //
    // バックエンドの URL とエンドポイントを定義
    // ---------------------------------------------------------------------
    const BACKEND_URL = "http://127.0.0.1:8000";
    const PROXY_ENDPOINT = `${BACKEND_URL}/api/realtime-proxy`;
    const WEBSOCKET_ENDPOINT = `${BACKEND_URL.replace("http", "ws")}/ws/function-call`;

    let peerConnection; // WebRTC 接続本体
    let dataChannel; // API イベント受信用 DataChannel
    let functionCallSocket; // バックエンド Function Calling 用 WS
    let localStream; // ユーザー音声 MediaStream
    const pendingCalls = {}; // Function Calling 実行指示を一時的に保持
    let currentUIState = ""; // UI の現在状態を文字列で管理

    // ---------------------------------------------------------------------
    // 3.  UI状態管理関数
    //
    // 状態(ready, connecting, active など)に応じて、画面表示／ボタン配置／テキストを切り替える
    // ---------------------------------------------------------------------
    function updateUI(newState) {
        currentUIState = newState;
        primaryButton.style.display = "flex";

        switch (newState) {
            // エージェントロード中
            case "agentLoading":
                overlayText.textContent = "エージェントを準備しています...";
                overlay.classList.remove("hidden");
                startPopup.classList.add("hidden");
                primaryButton.style.display = "none";
                statusText.textContent = "準備中...";
                break;
            // 開始前のタイトル
            case "ready":
                overlay.classList.add("hidden");
                startPopup.classList.remove("hidden");
                primaryButton.innerHTML = "おはなしをはじめる 🎤";
                primaryButton.disabled = false;
                buttonContainerPopup.appendChild(primaryButton);
                statusText.textContent = "準備完了";
                break;
            // Render(AI)に接続中
            case "connecting":
                startPopup.classList.add("hidden");
                overlayText.textContent = "AIに接続しています...";
                overlay.classList.remove("hidden");
                primaryButton.disabled = true;
                statusText.textContent = "接続中...";
                break;
            // メイン会話（録音中）
            case "active":
                overlay.classList.add("hidden");
                primaryButton.innerHTML = "🔇";
                primaryButton.disabled = false;
                primaryButton.classList.add("recording");
                buttonContainerMain.appendChild(primaryButton);
                statusText.textContent = "話してください";
                break;
            // メイン会話（ミュート中）
            case "muted":
                primaryButton.innerHTML = "🎤";
                primaryButton.disabled = false;
                primaryButton.classList.remove("recording");
                statusText.textContent = "ミュート中";
                break;
        }
    }

    // ---------------------------------------------------------------------
    // 4.  Primary button（録音／ミュート）
    //
    // セッション開始／ミュート切替など
    // ---------------------------------------------------------------------
    primaryButton.onclick = () => {
        switch (currentUIState) {
            case "ready":
                startSession();
                break;
            case "active":
                // 録音 → ミュート
                localStream?.getAudioTracks().forEach((t) => (t.enabled = false));
                updateUI("muted");
                break;
            case "muted":
                // ミュート → 録音
                localStream?.getAudioTracks().forEach((t) => (t.enabled = true));
                updateUI("active");
                break;
        }
    };

    // ---------------------------------------------------------------------
    // 5.  エージェント表示完了を監視
    //
    // ---------------------------------------------------------------------
    const observer = new MutationObserver(() => {
        if (agentVisibleFlag.textContent.trim() === "2") {
            updateUI("ready");
            observer.disconnect(); // 監視を停止
        }
    });
    observer.observe(agentVisibleFlag, { childList: true });

    // ---------------------------------------------------------------------
    // 6.  ログ出力
    //
    // デバッグ時にメッセージの内容をブラウザConsoleに整形出力
    // ---------------------------------------------------------------------
    function logMessage(sender, message) {
        // console.log(sender, message);
        console.log(`[${sender}] \n ${message}`);
    }
    function logMessage_oai_events(sender, message) {
        const type = message?.type || "unknown";
        if (type === "response.function_call_arguments.delta" || type === "response.audio_transcript.delta") return;
        console.groupCollapsed(`[${sender}] type: ${type}`);
        console.log(message);
        console.log(JSON.stringify(message, null, 2));
        console.groupEnd();
    }

    // ---------------------------------------------------------------------
    // 7.  チャットUIに吹き出し追加
    // ---------------------------------------------------------------------
    function addBubble(text, isUser = false) {
        const container = document.getElementById("chatContainer");
        if (!container) return;

        const bubbleDiv = document.createElement("div");
        bubbleDiv.className = isUser ? "bubble bubble-user" : "bubble bubble-ai";

        const messageDiv = document.createElement("div");
        messageDiv.className = "message-bubble";
        messageDiv.textContent = text;

        const timeDiv = document.createElement("div");
        timeDiv.className = "message-time";
        const now = new Date();
        timeDiv.textContent = `${now.getHours()}:${now.getMinutes().toString().padStart(2, "0")}`;

        bubbleDiv.appendChild(messageDiv);
        bubbleDiv.appendChild(timeDiv);

        container.appendChild(bubbleDiv);
        container.scrollTop = container.scrollHeight;
    }
    window.addBubble = addBubble;

    // ---------------------------------------------------------------------
    // 8.  メインセッション
    //
    // WebRTC と Web Scoket を確立
    // ---------------------------------------------------------------------
    async function startSession() {
        updateUI("connecting");

        try {
            // 1) UI／DOM の準備
            // AI音声再生用 <audio> 要素を作成
            const audioEl = document.createElement("audio");
            audioEl.autoplay = true;
            document.body.appendChild(audioEl);

            // 2) RTCPeerConnection の生成 & イベントハンドラ登録
            peerConnection = new RTCPeerConnection();

            // a) Offer-Answer交換完了時／音声が追加された時
            let started = false;
            peerConnection.ontrack = (event) => {
                if (started) return;
                started = true;
                audioEl.srcObject = event.streams[0]; // 音声再生
                audioEl.onplaying = () => updateUI("active"); // UI を active に変更
            };

            // b) 接続状態変化時（切断／失敗時はセッション終了）
            peerConnection.onconnectionstatechange = () => {
                logMessage("System", `接続状態: ${peerConnection.connectionState}`);
                if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
                    endSession();
                }
            };

            // 3) マイクを取得して WebRTC に追加
            try {
                const s = await navigator.permissions.query({ name: "microphone" });
                if (s.state === "denied") throw new Error("マイクへのアクセスがブロックされています。");
                localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                localStream.getTracks().forEach((t) => peerConnection.addTrack(t, localStream));
            } catch (e) {
                alert("マイクが使用できません。ブラウザ／OS の設定で許可してください。");
                console.error(e);
                updateUI("ready");
                return;
            }

            // 4) DataChannel 生成 & イベントリスナ登録
            dataChannel = peerConnection.createDataChannel("oai-events");
            setupDataChannelListeners();

            // 5) Function-Calling 用の WebSocket の確立（SDP とは無関係）
            setupFunctionCallSocket();

            // 6) SDP Offer の作成と設定（3・4 の情報を含んだ Offer を生成）
            const offer = await peerConnection.createOffer(); // peerConnection に登録されている情報をもとに生成
            await peerConnection.setLocalDescription(offer);

            // 7) Offer SDP を送信 → Answer SDP を受信・設定
            // a) Offer（SDP形式）をプロキシサーバに POST 送信
            const sdpResp = await fetch(PROXY_ENDPOINT, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: offer.sdp,
            });

            // b) サーバからのレスポンス（Answer SDP）の HTTP ステータスをチェックし、異常があれば処理を中断
            if (!sdpResp.ok) {
                const err = await sdpResp.text();
                throw new Error(`プロキシエラー: ${err}`);
            }

            // c) 正常時は、 Answer SDP を取得し、peerConnection に適用し、相手と直接つながる準備を完了させる
            const answerSdp = await sdpResp.text();
            await peerConnection.setRemoteDescription({ type: "answer", sdp: answerSdp });
            logMessage("System", "リアルタイム接続が確立されました！");
        } catch (err) {
            console.error("セッション開始エラー:", err);
            logMessage("Error", err.message);
            alert(`接続に失敗しました: ${err.message}`);
            endSession();
        }
    }

    // セッション終了処理
    function endSession() {
        if (localStream) localStream.getTracks().forEach((track) => track.stop());
        if (dataChannel) dataChannel.close();
        if (functionCallSocket) functionCallSocket.close();
        if (peerConnection) peerConnection.close();

        updateUI("ready");
        logMessage("System", "セッションが終了しました。");
    }

    // ---------------------------------------------------------------------
    // 9.  DataChannel 受信イベントハンドラ
    // ---------------------------------------------------------------------
    function setupDataChannelListeners() {
        dataChannel.onopen = () => logMessage("System", "データチャネルが開通しました");
        dataChannel.onclose = () => logMessage("System", "データチャネルが閉じました");
        dataChannel.onerror = (error) => logMessage("Error", `データチャネルエラー: ${error}`);

        dataChannel.onmessage = async (event) => {
            try {
                const msg = JSON.parse(event.data);
                logMessage_oai_events("OpenAI Event", msg);

                switch (msg.type) {
                    // ➊ ユーザー発話のテキスト化完了
                    case "conversation.item.input_audio_transcription.completed": {
                        if (msg.transcript) setTimeout(() => addBubble(msg.transcript, true), 0);
                        break;
                    }

                    // ➋ モデル応答（全文）受信完了
                    case "response.done": {
                        const transcript = msg?.response?.output?.[0]?.content?.[0]?.transcript ?? "";
                        if (transcript) setTimeout(() => addBubble(transcript, false), 800);
                        break;
                    }

                    // ➌ モデル応答開始（音声が追加された時）：口パク開始 + 波形アニメーション開始
                    case "response.content_part.added": {
                        Agent.startAgentSpeak();
                        voiceWaves.classList.add("active");
                        break;
                    }

                    // ➍ 音声再生終了：口パク停止 + 波形アニメーション停止
                    case "output_audio_buffer.stopped": {
                        Agent.stopAgentSpeak();
                        voiceWaves.classList.remove("active");
                        break;
                    }

                    // ▼ Function Calling 系イベント ▼
                    // ➎ 関数呼び出し開始イベント：pendingCalls 配列に一時保存
                    case "response.output_item.added":
                    case "response.function_call.created": {
                        const item = msg.item ?? msg; // 旧イベント互換
                        if (item.type === "function_call") {
                            pendingCalls[msg.output_index ?? 0] = {
                                call_id: item.call_id, // 一意の呼び出しID
                                name: item.name, // 呼び出す関数名
                                arguments: "", // 後続 delta で引数を構築
                            };
                            console.log(`[call start] name：${item.name} (call_id：${item.call_id})`);
                        }
                        break;
                    }

                    // ➏ 関数呼び出しの引数チャンクを受信：関数呼び出しの引数断片（delta）を受信し、連結して完全な引数文字列を構築
                    case "response.function_call_arguments.delta": {
                        const idx = msg.output_index ?? 0;
                        if (pendingCalls[idx]) {
                            pendingCalls[idx].arguments += msg.delta;
                        }
                        break;
                    }

                    // ➐ 関数呼び出し完了イベント：pendingCalls から情報を取り出し、WebSocket でバックエンドに実行依頼を送信
                    case "response.output_item.done": {
                        if (msg.item?.type !== "function_call") break;
                        const idx = msg.output_index ?? 0;
                        const call = pendingCalls[idx];
                        if (call && call.call_id === msg.item.call_id) {
                            functionCallSocket.send(JSON.stringify(call)); // バックエンド実行用 WebSocket にペイロード送信
                            delete pendingCalls[idx]; // 完了したコール情報をクリーンアップ
                            console.log(`[call exec] name：${call.name} (${call.arguments})`);
                        }
                        break;
                    }

                    default:
                        break;
                }
            } catch (e) {
                console.error("メッセージ処理エラー:", e);
                logMessage("Error", e.message);
            }
        };
    }

    // ---------------------------------------------------------------------
    // 10.  Function Calling 用 WebSocket 設定
    // ---------------------------------------------------------------------
    function setupFunctionCallSocket() {
        // 1) WebSocketオブジェクトを生成して接続を開始
        functionCallSocket = new WebSocket(WEBSOCKET_ENDPOINT);

        // 2) ログを出力
        functionCallSocket.onopen = () => logMessage("System", "関数実行用WebSocketが開通しました");
        functionCallSocket.onclose = () => logMessage("System", "関数実行用WebSocketが閉じました");
        functionCallSocket.onerror = (error) => logMessage("Error", `WebSocketエラー: ${error}`);

        // 3) message イベント：バックエンドからのレスポンスを受信
        functionCallSocket.onmessage = (event) => {
            const response = JSON.parse(event.data);
            logMessage("Backend", response);

            // 3-1) レスポンスが success の場合：関数呼び出し結果を AI 側に送信
            if (response.status === "success") {
                const toolOutputEvent = {
                    type: "conversation.item.create",
                    item: {
                        type: "function_call_output",
                        call_id: response.call_id,
                        output: JSON.stringify(response.result),
                    },
                };
                dataChannel.send(JSON.stringify(toolOutputEvent));
                dataChannel.send(JSON.stringify({ type: "response.create" }));
                logMessage("System", "関数の実行結果をOpenAIに送信しました");
            } 
            // 3-2) レスポンスが failure の場合：エラー情報を AI 側に送信
            else {
                dataChannel.send(
                    JSON.stringify({
                        type: "conversation.item.create",
                        item: {
                            type: "function_call_output",
                            call_id: response.call_id,
                            error: response.message,
                        },
                    })
                );
                dataChannel.send(JSON.stringify({ type: "response.create" }));
                logMessage("Error", `関数実行失敗: ${response.message}`);
            }
        };
    }

    // ---------------------------------------------------------------------
    // 11.  初期状態: エージェント読み込み開始
    // ---------------------------------------------------------------------
    updateUI("agentLoading");
});

/************************************************
 * Live2D Agent Misaki
 ************************************************/
const position_Agent = { boxWidth: 2500, boxHeight: 2500, modelScale: 0.56, modelX: 200, modelY: 2000 };

const modelPath_Agent = "https://cdn.jsdelivr.net/gh/TeradaLab-Agents/Agent-Misaki@1f5d8f07eb2b7396c5309b200a4d8a6515c06ba4/GeminoidF/moc/GeminoidF_new2/GeminoidF_new2.model3.json";
const resourcePath_Agent = "https://cdn.jsdelivr.net/gh/TeradaLab-Agents/Agent-Misaki@1f5d8f07eb2b7396c5309b200a4d8a6515c06ba4/js/indexLibrary_boyA.js";

class SetAgent {
    constructor(debug, serverURL, modelPath, resourcePath, position, canvasId) {
        this.debug = debug;
        this.serverURL = serverURL;
        this.modelPathPath = modelPath;
        this.resourcePath = resourcePath;
        this.position = position;
        this.canvasId = canvasId;
        this.init();
    }
    init() {
        const requiredResources = ["https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js", "https://cdn.jsdelivr.net/gh/dylanNew/live2d/webgl/Live2D/lib/live2d.min.js", this.resourcePath];
        const loadScript = (i) => {
            jQuery.getScript(requiredResources[i], function () {
                if (i + 1 < requiredResources.length) loadScript(i + 1);
                else initExp();
            });
        };
        const initExp = () => {
            this.indexLibrary = new IndexLibrary(this.debug, this.serverURL, this.modelPathPath, this.position, this.canvasId);
            this.indexLibrary.onload();
        };
        loadScript(0);
    }
    setAgentExpression(expression) {
        switch (expression) {
            case "Neutral":
                this.indexLibrary.App_set_Neutral(0);
                break;
            case "Joy":
                this.indexLibrary.App_set_Joy(1);
                break;
            case "Affiliation":
                this.indexLibrary.App_set_Affiliation(1);
                break;
            case "Dominance":
                this.indexLibrary.App_set_Dominance(1);
                break;
            case "Sadness":
                this.indexLibrary.App_set_Sadness(1);
                break;
            case "Anger":
                this.indexLibrary.App_set_Anger(1);
                break;
            case "Regret":
                this.indexLibrary.App_set_Regret(1);
                break;
            case "Surprised":
                this.indexLibrary.App_set_Surprised(1);
                break;
            case "Fear":
                this.indexLibrary.App_set_Fear(1);
                break;
            case "Disgust":
                this.indexLibrary.App_set_Disgust(1);
                break;
            default:
                break;
        }
    }
    resetAgentExpression() {
        this.indexLibrary.App_set_Neutral(0);
    }
    startAgentSpeak() {
        this.indexLibrary.App_StartSpeak(1.5, 0.25);
    }
    stopAgentSpeak() {
        this.indexLibrary.App_StopSpeak();
    }
}
const Agent = new SetAgent(false, "", modelPath_Agent, resourcePath_Agent, position_Agent, "myCanvas1");
