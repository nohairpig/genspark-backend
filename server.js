const express = require("express");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const isWindows = process.platform === "win32";

function runGsk(args, options, callback) {
    if (isWindows) {
        execFile(
            "cmd.exe",
            ["/c", "gsk.cmd", ...args],
            options,
            callback
        );
    } else {
        execFile(
            "gsk",
            args,
            options,
            callback
        );
    }
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ========================================
// 從 CLI 輸出中取出完整 JSON
// ========================================
function extractJson(output) {
    const start = output.indexOf("{");
    const end = output.lastIndexOf("}");

    if (start === -1 || end === -1 || end < start) {
        throw new Error("找不到完整 JSON");
    }

    const jsonText = output.substring(start, end + 1);

    return JSON.parse(jsonText);
}

async function fetchRecommendation(
    userId,
    sessionId
) {
    const url =
        `https://recommendation-backend-poq1.onrender.com/api/recommendation/current/${userId}/${sessionId}`;

    console.log("開始取得 Recommendation：");
    console.log(url);

    const response = await fetch(url);

    if (!response.ok) {
        const errorText =
            await response.text();

        throw new Error(
            `Recommendation API 失敗：${response.status} ${errorText}`
        );
    }

    const data =
        await response.json();

    if (!data.recommendation) {
        throw new Error(
            "Recommendation API 沒有 recommendation"
        );
    }

    return data.recommendation;
}

// ========================================
// 測試 Backend
// ========================================
app.get("/", (req, res) => {
    res.send("Genspark backend is running");
});

// ========================================
// 產生冥想語音
// ========================================
app.post("/generate-voice", (req, res) => {
    try {
        const { text } = req.body;

        if (!text || text.trim() === "") {
            return res.status(400).json({
                success: false,
                error: "缺少 text"
            });
        }

        console.log("\n==============================");
        console.log("收到冥想文字：");
        console.log(text);

        // ========================================
        // 建立 Genspark TTS 參數
        // ========================================
        const argsFilePath = path.join(
            __dirname,
            "tts-temp.json"
        );

        const ttsData = {
            prompt: text,
            model: "elevenlabs/v3-tts",
            audio_type: "speech",
            file_name: "meditation_voice",

            params: {
                speaker: "Arabella",
                stability: 0.4,
                similarity_boost: 0.75,
                style: 0.35,
                output_format: "mp3_44100_128"
            }
        };

        fs.writeFileSync(
            argsFilePath,
            JSON.stringify(ttsData, null, 2),
            "utf8"
        );

        console.log("開始呼叫 Genspark 產生語音...");

        // ========================================
        // STEP 1
        // Genspark 產生 Audio
        // ========================================
        runGsk(
            [
                "audio",
                "--args-file",
                argsFilePath
            ],
            {
                windowsHide: true
            },
            (audioError, audioStdout, audioStderr) => {

                if (audioError) {
                    console.error(
                        "Genspark audio 執行失敗：",
                        audioError
                    );

                    console.error(audioStderr);

                    return res.status(500).json({
                        success: false,
                        error: "Genspark 語音生成失敗"
                    });
                }

                console.log("Audio 生成完成");

                try {
                    // ========================================
                    // 解析 audio_generation 回傳
                    // ========================================
                    const audioResult =
                        extractJson(audioStdout);

                    const wrapperUrl =
                        audioResult
                            ?.data
                            ?.generated_audios?.[0]
                            ?.audio_urls?.[0];

                    if (!wrapperUrl) {
                        console.error(
                            "沒有找到 wrapperUrl"
                        );

                        console.log(audioStdout);

                        return res.status(500).json({
                            success: false,
                            error: "Genspark 沒有回傳音檔網址"
                        });
                    }

                    console.log("取得 wrapper URL：");
                    console.log(wrapperUrl);

                    // ========================================
                    // STEP 2
                    // wrapper URL → 真正下載 URL
                    // ========================================
                    runGsk(
                        [
                            "download",
                            wrapperUrl
                        ],
                        {
                            windowsHide: true
                        },
                        (
                            downloadError,
                            downloadStdout,
                            downloadStderr
                        ) => {

                            if (downloadError) {
                                console.error(
                                    "gsk download 失敗：",
                                    downloadError
                                );

                                console.error(
                                    downloadStderr
                                );

                                return res
                                    .status(500)
                                    .json({
                                        success: false,
                                        error:
                                            "無法取得真正下載網址"
                                    });
                            }

                            console.log(
                                "Download API 回傳完成"
                            );

                            try {
                                // ========================================
                                // 解析多行 JSON
                                // ========================================
                                const downloadResult =
                                    extractJson(
                                        downloadStdout
                                    );

                                const finalAudioUrl =
                                    downloadResult
                                        ?.data
                                        ?.download_url;

                                if (!finalAudioUrl) {
                                    console.error(
                                        "找不到 download_url"
                                    );

                                    console.log(
                                        downloadStdout
                                    );

                                    return res
                                        .status(500)
                                        .json({
                                            success: false,
                                            error:
                                                "沒有取得 download_url"
                                        });
                                }

                                console.log(
                                    "真正音檔網址取得成功"
                                );

                                console.log(
                                    finalAudioUrl
                                );

                                // ========================================
                                // 回傳給 Unity
                                // ========================================
                                return res.json({
                                    success: true,
                                    audioUrl:
                                        finalAudioUrl
                                });

                            } catch (
                                downloadParseError
                            ) {
                                console.error(
                                    "download JSON 解析失敗：",
                                    downloadParseError
                                );

                                console.log(
                                    "原始 download 輸出："
                                );

                                console.log(
                                    downloadStdout
                                );

                                return res
                                    .status(500)
                                    .json({
                                        success: false,
                                        error:
                                            "download 回傳解析失敗"
                                    });
                            }
                        }
                    );

                } catch (audioParseError) {
                    console.error(
                        "Audio JSON 解析失敗：",
                        audioParseError
                    );

                    console.log(
                        "原始 Audio 輸出："
                    );

                    console.log(audioStdout);

                    return res
                        .status(500)
                        .json({
                            success: false,
                            error:
                                "Genspark 回傳解析失敗"
                        });
                }
            }
        );

    } catch (error) {
        console.error(
            "Backend 發生錯誤：",
            error
        );

        return res.status(500).json({
            success: false,
            error: "Server error"
        });
    }
});

// ========================================
// Recommendation → Genspark → 冥想腳本
// ========================================
app.post(
    "/generate-script-from-recommendation",
    (req, res) => {

        try {
            const { recommendation } = req.body;

            if (!recommendation) {
                return res.status(400).json({
                    success: false,
                    error: "缺少 recommendation"
                });
            }

            const scene =
                recommendation.scene || "";

            const breathing =
                recommendation.breathing || "";

            const technique =
                recommendation.technique || "";

            const guidance =
                recommendation.guidance || {};

            const guidanceId =
                guidance.id || "";

            const voiceParameters =
                guidance.voiceParameters || {};

            const voiceTone =
                voiceParameters.voiceTone || "";

            const speed =
                voiceParameters.speed || "";

            const density =
                voiceParameters.density || "";

            const silenceRatio =
                voiceParameters.silenceRatio || {};

            const silenceMin =
                silenceRatio.min ?? "";

            const silenceMax =
                silenceRatio.max ?? "";

            // ========================================
            // 不需要人聲
            // ========================================
            if (guidanceId === "ambient_only") {
                return res.json({
                    success: true,
                    useVoice: false,
                    script: ""
                });
            }

            console.log("\n==============================");
            console.log("Recommendation → Genspark");
            console.log("scene:", scene);
            console.log("breathing:", breathing);
            console.log("technique:", technique);
            console.log("guidance:", guidanceId);
            console.log("voiceTone:", voiceTone);
            console.log("speed:", speed);
            console.log("density:", density);
            console.log(
                "silenceRatio:",
                silenceMin,
                "-",
                silenceMax
            );

            // ========================================
            // 給 Genspark 的推薦內容
            // ========================================
            const query = `
        請根據以下推薦結果，
        生成一段個人化的繁體中文冥想語音引導。

        場景：
        ${scene}

        呼吸方式：
        ${breathing}

        冥想技巧：
        ${technique}

        陪伴方式：
        ${guidanceId}

        語氣：
        ${voiceTone}

        語速：
        ${speed}

        引導密度：
        ${density}

        安靜比例：
        ${silenceMin} 到 ${silenceMax}

        請將以上內容自然整合進冥想引導中，
        不要直接念出這些參數名稱。
        `.trim();

            let instructions = `
        你是一位專門設計個人化冥想引導內容的助手。

        請使用繁體中文。

        這段文字最後會直接交給文字轉語音模型朗讀。

        因此：
        只輸出真正要朗讀的冥想內容。

        不要輸出：
        - 標題
        - 分析
        - 推薦理由
        - 問卷內容
        - 設定參數名稱
        - 結束說明

        禁止在內容最後加入字數、朗讀時間、停頓比例、設計說明、備註或任何統計資訊。

        請自然將場景、呼吸方式與冥想技巧融合在內容中。

        場景不要直接說：
        「你的場景是 ${scene}」

        而是透過感官與意象自然呈現。

        呼吸方式必須實際出現在引導中。

        冥想技巧也必須真正融入內容。

        如果 technique 是 grounding，
        可以使用：
        - 身體與椅子的接觸感
        - 腳底感受
        - 呼吸
        - 聲音
        - 當下感官

        幫助使用者把注意力帶回現在。

        不要要求使用者：
        - 清空大腦
        - 停止思考
        - 不要焦慮
        - 強迫自己放鬆

        如果走神，
        請使用：

        注意到 → 接納 → 輕輕回到呼吸或感官。

        句子保持簡短、自然，
        適合慢速語音朗讀。

        可以少量使用：

        [warmly]
        [reassuring]
        [pause]
        [inhales]
        [exhales]
        [whispers]

        目前先生成約 1 分鐘內容。
        `;

            // ========================================
            // 聲音質地：Arabella・全程耳語氣音・stability 0.4
            // ========================================
            instructions += `

        這次的聲音狀態，從第一句到最後一句都必須完全一致。

        聲音質地：
        - 溫柔女聲
        - 全程耳語、氣音，像靠得很近、在耳邊輕輕說話
        - 不要中途變回正常說話聲
        - 不要前段很輕、後段變清楚
        - 整段維持同一個音量與同一個距離感
        - 不要出現明亮、清脆、播報式的聲音

        柔和的具體做法：
        - 音量再低一階，比平常說話更輕
        - 句尾自然變輕、往下放，不要上揚
        - 不要強調重音
        - 不要讓咬字有清楚的稜角
        - 音節之間稍微連一點，不要一字一字分明
        - 不要提高音調，不要用感嘆的語氣
        - 每一句說完，讓聲音先完全消失，再出現下一句

        再柔一點。

        句子寧可短，不要長。
        一句裡不要塞兩個以上的動作。

        多用這種開頭：
        - 「可以……」
        - 「如果願意……」
        - 「慢慢……」
        - 「不急……」

        避免：
        - 連續兩個指令句
        - 句尾語氣上揚
        - 需要用力才說得出來的詞
        - 任何聽起來像在「帶領課程」的說法

        重要的句子說完之後，
        先留白，再說話。
        `;

            // ========================================
            // 呼吸音：只在真正要呼吸的地方出現
            // ========================================
            instructions += `

        如果腳本中有呼吸的動作，聲音本身也要出現。

        請這樣標記：

        - 引導吸氣之後，加上 [inhales]
        - 引導吐氣之後，加上 [exhales]
        - 吐氣可以比吸氣長一點
        - 必要時可以連續兩個 [exhales]
        - 只有在真的要使用者呼吸的地方才加
        - 整段大約 2 到 4 次呼吸音就足夠
        - 不要每一句都加
        - 呼吸音要落在停頓裡，不要和說話的文字重疊

        不要把呼吸聲寫成描述，
        不要寫「現在有呼吸的聲音」，
        只要讓聲音自然出現就好。
        `;

            // ========================================
            // guidance
            // ========================================
            if (guidanceId === "gentle_companion") {
                instructions += `

        使用者希望被溫柔陪伴。

        請減少命令式語言，
        多使用陪伴、允許、接納與溫柔提醒。

        像一個值得信任的人，
        安靜地陪在使用者身旁。
        `;
            }

            if (guidanceId === "guided_relaxation") {
                instructions += `

        使用者希望得到較明確的引導。

        請一步一步帶著使用者進行：
        姿勢調整、呼吸、身體覺察與冥想。
        `;
            }

            if (
                guidanceId ===
                "quiet_with_encouragement"
            ) {
                instructions += `

        使用者偏好較多安靜。

        請減少文字量，
        只保留必要的引導與簡短鼓勵。
        `;
            }

            // ========================================
            // voiceTone
            // ========================================
            if (voiceTone === "warm_gentle") {
                instructions += `

            這次的 voiceTone 是 warm_gentle。

            請讓每一句都像靠近使用者、
            低聲且溫柔地陪伴。

            多使用：
            - 「可以慢慢來」
            - 「不用急」
            - 「如果願意的話」
            - 「就先待在這裡」
            - 「沒關係」
            - 「我會陪你」

            少使用：
            - 「現在請」
            - 「接下來」
            - 「你需要」
            - 「你必須」
            - 連續命令句

            語氣應該安靜、柔和、帶有安全感，
            不要像主持人、旁白、教學老師或語音助理。
           `;
            }

            // ========================================
            // speed
            // ========================================
            if (speed === "slow") {
                    instructions += `

                這次的語速設定為 slow。

                這不是一般敘事速度，
                而是非常緩慢的冥想引導速度。

                請遵守：

                - 一次只說一個簡短概念
                - 每句盡量控制在 15～20 個中文字以內
                - 每 1～2 句至少加入一次 [pause]
                - 呼吸指令後一定要加入 [pause]
                - 身體感受指令後一定要加入 [pause]
                - 不要連續快速說三句以上
                - 多使用句號、刪節號與換行
                - 避免長句與大量逗號

                讓使用者真的有時間完成呼吸與感受，
                而不是只聽見一連串指令。
                `;
            }

            // ========================================
            // density
            // ========================================
            if (density === "medium") {
                instructions += `

        引導密度為中等。

        不要持續不停說話，
        也不要完全缺乏引導。
        `;
            }

            // ========================================
            // silenceRatio
            // ========================================
            if (
                silenceMin !== "" &&
                silenceMax !== ""
            ) {
                instructions += `

                        安靜比例約為：

                ${Math.round(silenceMin * 100)}% 到 ${Math.round(silenceMax * 100)}%

                請實際反映在腳本結構中。

                例如 30%～35% 的安靜比例，
                代表整段語音中大約三分之一應該沒有新的語句。

                因此：

                - 每段引導之間加入 [pause]
                - 呼吸練習中可以連續出現兩次 [pause]
                - 不要用更多文字填滿原本應該安靜的時間
                - 寧可少說一些，也不要持續說話

                [inhales] 與 [exhales] 出現的地方，
                時間本來就該是安靜的，
                不要因為加了呼吸音，
                又用文字把空隙填滿。

                請讓使用者有足夠時間真正完成：
                吸氣、
                吐氣、
                感受身體、
                聽環境聲音。
             `;
            }

            // ========================================
            // 建立 Genspark args
            // ========================================
            const scriptArgsPath =
                path.join(
                    __dirname,
                    "recommendation-script-temp.json"
                );

            const scriptArgs = {
                task_name:
                    "Recommendation Meditation Script",

                query: query,

                instructions: instructions
            };

            fs.writeFileSync(
                scriptArgsPath,
                JSON.stringify(
                    scriptArgs,
                    null,
                    2
                ),
                "utf8"
            );

            console.log(
                "開始呼叫 Genspark Super Agent..."
            );

            // ========================================
            // 呼叫 Genspark
            // ========================================
            runGsk(
                [
                    "task",
                    "create",
                    "super_agent",
                    "--args-file",
                    scriptArgsPath,
                    "--wait",
                    "true"
                ],
                {
                    windowsHide: true
                },
                (error, stdout, stderr) => {
                    if (error) {
                        console.error(
                            "Genspark 腳本生成失敗：",
                            error
                        );

                        console.error(
                            "Genspark stdout：",
                            stdout
                        );

                        console.error(
                            "Genspark stderr：",
                            stderr
                        );

                        return res.status(500).json({
                            success: false,
                            error: "Genspark 冥想腳本生成失敗"
                        });
                    }

                    try {
                        const result =
                            extractJson(stdout);

                        const content =
                            result
                                ?.data
                                ?.result_content
                                ?.content;

                        if (
                            !content ||
                            !Array.isArray(content) ||
                            content.length === 0
                        ) {
                            console.error(
                                "找不到冥想腳本"
                            );

                            console.log(stdout);

                            return res.status(500).json({
                                success: false,
                                error:
                                    "Genspark 沒有回傳冥想腳本"
                            });
                        }

                        const script =
                            content[0].trim();

                        console.log(
                            "Recommendation 冥想腳本生成完成："
                        );

                        console.log(script);

                        return res.json({
                            success: true,
                            useVoice: true,
                            script: script
                        });

                    } catch (parseError) {
                        console.error(
                            "Genspark JSON 解析失敗：",
                            parseError
                        );

                        console.log(stdout);

                        return res.status(500).json({
                            success: false,
                            error:
                                "Genspark 腳本解析失敗"
                        });
                    }
                }
            );

        } catch (error) {
            console.error(
                "Recommendation 腳本流程錯誤：",
                error
            );

            return res.status(500).json({
                success: false,
                error:
                    "Recommendation 腳本產生失敗"
            });
        }
    }
);

// ========================================
// 測試 Render Recommendation API
// ========================================
app.post(
    "/test-recommendation",
    async (req, res) => {

        try {
            const {
                user_id,
                session_id,
                sceneName
            } = req.body;

            if (
                !user_id ||
                !session_id
            ) {
                return res.status(400).json({
                    success: false,
                    error:
                        "缺少 user_id 或 session_id"
                });
            }

            const recommendation =
                await fetchRecommendation(
                    user_id,
                    session_id
                );

            console.log(
                "成功取得 recommendation："
            );

            console.log(
                JSON.stringify(
                    recommendation,
                    null,
                    2
                )
            );

            return res.json({
                success: true,
                recommendation:
                    recommendation
            });

        } catch (error) {

            console.error(
                "取得 recommendation 失敗：",
                error
            );

            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);

// ========================================
// 啟動 Server
// ========================================
const server = app.listen(PORT, "0.0.0.0", () => {
    console.log("==============================");
    console.log(`Server running on port ${PORT}`);
    console.log("Server PID:", process.pid);
    console.log("==============================");
});

server.on("error", (error) => {
    console.error("Server 發生錯誤：", error);
});

server.on("close", () => {
    console.error("⚠️ Server 被關閉了");
});

process.on("exit", (code) => {
    console.error("⚠️ Node process 結束，exit code =", code);
});

process.on("uncaughtException", (error) => {
    console.error("❌ uncaughtException：", error);
});

process.on("unhandledRejection", (reason) => {
    console.error("❌ unhandledRejection：", reason);
});

// ========================================
// 正式個人化冥想 API
// 目前先測試 Render Recommendation
// ========================================
app.post(
    "/generate-personalized-meditation",
    async (req, res) => {

        try {

            const {
                user_id,
                session_id,
                sceneName
            } = req.body;

            if (!user_id || !session_id) {
                return res.status(400).json({
                    success: false,
                    error: "缺少 user_id 或 session_id"
                });
            }

            console.log("\n==============================");
            console.log("開始正式個人化冥想流程");
            console.log("user_id:", user_id);
            console.log("session_id:", session_id);
            console.log("sceneName:", sceneName);

            // STEP 1：從 Render 取得推薦結果
            const recommendation =
                await fetchRecommendation(
                    user_id,
                    session_id
                );
            console.log(
                "Render 原本 scene：",
                recommendation.scene
            );

            if (
                sceneName &&
                sceneName.trim() !== ""
            ) {
                recommendation.scene =
                    sceneName.trim();

                console.log(
                    "已改用 Firebase / Unity sceneName：",
                    recommendation.scene
                );
            }
            else
            {
                console.log(
                    "沒有收到 sceneName，維持 Render scene：",
                    recommendation.scene
                );
            }
            
            console.log(
                "成功取得 Recommendation："
            );

            console.log(
                JSON.stringify(
                    recommendation,
                    null,
                    2
                )
            );

            // ========================================
            // STEP 2：Recommendation → Genspark 腳本
            // ========================================
            console.log(
                "STEP 2：開始產生個人化冥想腳本..."
            );

            const scriptResponse =
                await fetch(
                    `http://127.0.0.1:${PORT}/generate-script-from-recommendation`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            recommendation:
                                recommendation
                        })
                    }
                );

            const scriptResult =
                await scriptResponse.json();

            if (
                !scriptResponse.ok ||
                !scriptResult.success
            ) {
                console.error(
                    "冥想腳本生成失敗：",
                    scriptResult
                );

                return res.status(500).json({
                    success: false,
                    error:
                        scriptResult.error ||
                        "冥想腳本生成失敗"
                });
            }

            // 如果不需要人聲
            if (
                scriptResult.useVoice === false
            ) {
                return res.json({
                    success: true,
                    useVoice: false,
                    recommendation:
                        recommendation,
                    script: "",
                    audioUrl: ""
                });
            }

            const script =
                scriptResult.script;

            if (
                !script ||
                script.trim() === ""
            ) {
                return res.status(500).json({
                    success: false,
                    error:
                        "沒有取得冥想腳本"
                });
            }

            console.log(
                "STEP 2 完成：取得冥想腳本"
            );

            console.log(script);

            // ========================================
            // STEP 3：冥想腳本 → TTS
            // ========================================
            console.log(
                "STEP 3：開始產生語音..."
            );

            const voiceResponse =
                await fetch(
                    `http://127.0.0.1:${PORT}/generate-voice`,
                    {
                        method: "POST",

                        headers: {
                            "Content-Type":
                                "application/json"
                        },

                        body: JSON.stringify({
                            text: script
                        })
                    }
                );

            const voiceResult =
                await voiceResponse.json();

            if (
                !voiceResponse.ok ||
                !voiceResult.success
            ) {
                console.error(
                    "語音生成失敗：",
                    voiceResult
                );

                return res.status(500).json({
                    success: false,
                    error:
                        voiceResult.error ||
                        "語音生成失敗"
                });
            }

            if (!voiceResult.audioUrl) {
                return res.status(500).json({
                    success: false,
                    error:
                        "沒有取得 audioUrl"
                });
            }

            console.log(
                "STEP 3 完成：語音生成成功"
            );

            console.log(
                "完整個人化冥想生成完成"
            );

            // ========================================
            // 最後回傳
            // ========================================
            return res.json({
                success: true,

                useVoice: true,

                recommendation:
                    recommendation,

                script:
                    script,

                audioUrl:
                    voiceResult.audioUrl
            });

        } catch (error) {

            console.error(
                "正式流程錯誤：",
                error
            );

            return res.status(500).json({
                success: false,
                error: error.message
            });
        }
    }
);
