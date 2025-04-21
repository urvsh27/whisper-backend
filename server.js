// server.js
const express = require("express");
const http = require("http");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");
const { WebSocketServer } = require("ws");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");
const { AssemblyAI } = require("assemblyai");
dotenv.config();
const axios = require("axios");

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// LiveKit configuration
const livekitHost = process.env.LIVEKIT_HOST || "LIVEKIT_HOST";
const apiKey = process.env.LIVEKIT_API_KEY || "LIVEKIT_API_KEY";
const apiSecret = process.env.LIVEKIT_API_SECRET || "LIVEKIT_API_SECRET";
const BLACK_BOX_AI_API_KEY = process.env.BLACK_BOX_AI_API_KEY;

// Initialize AssemblyAI client
const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY || "YOUR_ASSEMBLYAI_API_KEY",
});

// in memory map
const conversationHistories = new Map();

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("New WebSocket connection");

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "speech") {
        const roomName = data.roomName;
        const audioData = Buffer.from(data.audio, "base64");

        console.log(`Received audio from room ${roomName}`);

        if (!conversationHistories.has(roomName)) {
          conversationHistories.set(roomName, []);
        }
        const conversationHistory = conversationHistories.get(roomName);

        try {
          const text = await speechToText(audioData);
          console.log(`Speech recognized: ${text}`);

          if (text.trim() === "") {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Could not understand audio",
              })
            );
            return;
          }

          const aiResponse = await processWithAI(text, conversationHistory);
          conversationHistory.push({ role: "user", content: text });
          conversationHistory.push({ role: "assistant", content: aiResponse });

          ws.send(
            JSON.stringify({
              type: "ai_response",
              userText: text,
              aiText: aiResponse,
            })
          );
        } catch (processingError) {
          console.error("Error processing speech:", processingError);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Error processing speech",
            })
          );
        }
      } else if (data.type === "text_message") {
        const roomName = data.roomName || "default-room";
        const message = data.message;

        if (!conversationHistories.has(roomName)) {
          conversationHistories.set(roomName, []);
        }
        const conversationHistory = conversationHistories.get(roomName);

        try {
          const aiResponse = await processWithAI(message, conversationHistory);
          conversationHistory.push({ role: "user", content: message });
          conversationHistory.push({ role: "assistant", content: aiResponse });

          ws.send(
            JSON.stringify({
              type: "ai_response",
              userText: message,
              aiText: aiResponse,
            })
          );
        } catch (processingError) {
          console.error("Error processing message:", processingError);
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Error processing message",
            })
          );
        }
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Failed to process message",
        })
      );
    }
  });
});

// Generate a token for user to join a room
app.get("/get-token", async (req, res) => {
  try {
    const roomName = `ai-room-${Date.now()}`;
    const identity = "user";

    const token = new AccessToken(apiKey, apiSecret, {
      identity: identity,
      name: identity,
    });
    token.addGrant({ roomJoin: true, room: roomName });

    // Initialize conversation history
    conversationHistories.set(roomName, []);

    const jwt_token = await token.toJwt();
    res.json({
      roomName,
      token: jwt_token,
      identity,
    });
  } catch (error) {
    console.error("Error getting token:", error);
    res.status(500).json({ error: "Failed to get token" });
  }
});

// Speech-to-text function
async function speechToText(audioBuffer) {
  try {
    // Create a temporary file to store the audio buffer
    const tempDir = path.join(__dirname, "temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFile = path.join(tempDir, `speech_${Date.now()}.wav`);
    fs.writeFileSync(tempFile, audioBuffer);

    // Use AssemblyAI to transcribe the audio file
    const transcript = await client.transcripts.transcribe({
      audio: tempFile,
    });

    // Clean up the temporary file
    fs.unlinkSync(tempFile);

    return transcript.text;
  } catch (error) {
    console.error("Speech-to-text error:", error);
    throw error;
  }
}

// Process text with AI
async function processWithAI(user_text, conversationHistory) {
  try {
    const api_payload = {
      messages: [
        // ...(conversationHistory ?? {}),
        // {
        //   role: "system",
        //   content:
        //     "You are a helpful AI assistant speaking with a user through a voice interface. Keep your responses concise and conversational and short.",
        // },
        {
          role: "user",
          content: user_text,
          id: "hWiECRe",
        },
      ],
      agentMode: {},
      previewToken: null,
      userId: null,
      codeModelMode: true,
      trendingAgentMode: {},
      isMicMode: false,
      userSystemPrompt: null,
      maxTokens: 1024,
      validated: BLACK_BOX_AI_API_KEY,
    };
    const response = await fetch("https://www.blackbox.ai/api/chat", {
      method: "POST",

      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9,hi;q=0.8,gu;q=0.7",
        "content-type": "application/json",
        origin: "https://www.blackbox.ai",
        priority: "u=1, i",
        "sec-ch-ua":
          '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify(api_payload),
      responseType: "text", // This tells Axios to treat the response as plain text
    });

    if (!response.ok) {
      throw new Error("Failed to generate speech");
    }

    const response_text = await response?.text();
    return response_text;
  } catch (error) {
    console.error("AI processing error:", error);
    return "I'm sorry, I couldn't process that request.";
  }
}


const server_log = `Server running on port ${PORT}`

app.get("/", (req, res) => {
  res.json({
   message : server_log
  });
});

// Start the server
const PORT = process.env.PORT || 4001;
server.listen(PORT, () => {
  console.log(server_log);
});
