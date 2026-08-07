const crypto = require("crypto");
if (!globalThis.crypto) globalThis.crypto = crypto;
const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const { getSecret } = require("./keyvault");
const { ServiceBusClient } = require("@azure/service-bus");
const { BlobServiceClient } = require("@azure/storage-blob");
const { Pool } = require("pg");
const { createClient } = require("redis");
const dotenv = require("dotenv");
dotenv.config();

const server = http.createServer(app);

// ✅ KHỞI TẠO SOCKET.IO NATIVE (NHAU VỚI AZURE APP SERVICE LINUX TRỰC TIẾP)
const io = new Server(server, {
  pingTimeout: 60000,
  cors: {
    origin: "*", 
    methods: ["GET", "POST"],
  },
  connectionStateRecovery: {},
  transports: ["polling", "websocket"] 
});

// Khai báo biến toàn cục
let pool;
let redisClient;
let blobServiceClient;

// ==========================================
// HÀM KHỞI ĐỘNG SERVER CHÍNH TỪ KEY VAULT
// ==========================================
async function startServer() {
  try {
    console.log("⏳ Đang kết nối tới Azure Key Vault...");
    
    const dbConnectionString = await getSecret("DB-CONNECTION-STRING");
    const redisConnectionString = await getSecret("REDIS-CONNECTION-STRING");
    
    const sbConnectionString = process.env.SERVICEBUS_CONNECTION_STRING;
    const blobConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;

    // 1. KHỞI TẠO POSTGRESQL
    pool = new Pool({
      connectionString: dbConnectionString,
      ssl: { rejectUnauthorized: false }
    });

    pool.connect((err, client, release) => {
      if (err) console.error("❌ Lỗi kết nối Azure PostgreSQL:", err.stack);
      else {
        console.log("🐘 Đã kết nối thành công với Azure PostgreSQL từ Key Vault!");
        const createTableQuery = `
          CREATE TABLE IF NOT EXISTS match_history (
            id SERIAL PRIMARY KEY,
            room_code VARCHAR(50),
            player_name VARCHAR(100),
            score INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `;
        client.query(createTableQuery, (err) => {
          if (err) console.error("❌ Lỗi tạo bảng:", err);
          else console.log("✅ Bảng match_history đã sẵn sàng!");
          release(); 
        });
      }
    });

    // 2. KHỞI TẠO REDIS
    const formattedRedisUrl = `rediss://:${redisConnectionString}@skribbl-redis-managed.japaneast.redis.azure.net:10000`;
    redisClient = createClient({ url: formattedRedisUrl }); 
    
    redisClient.on("error", (err) => console.error("❌ Lỗi Redis:", err));
    redisClient.on("connect", () => console.log("⚡ Đã kết nối Azure Managed Redis từ Key Vault!"));
    await redisClient.connect();

    // 3. KHỞI TẠO SERVICE BUS
    if (sbConnectionString) {
      const sbClient = new ServiceBusClient(sbConnectionString);
      const sender = sbClient.createSender("test-skribbl-queue");
      await sender.sendMessages({
        body: { message: "Hello từ Skribbl Game (Key Vault Init)!", timestamp: new Date() }
      });
      console.log("🚌 [Service Bus] Đã kết nối & gửi tin nhắn test thành công!");
      await sender.close();
      await sbClient.close();
    }

    // 4. KHỞI TẠO BLOB STORAGE
    if (blobConnectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(blobConnectionString);
    }

    // 5. CHẠY SERVER LẮNG NGHE PORT
    const port_no = process.env.PORT || 3001;
    server.listen(port_no, () => {
      console.log(`🚀 Server listening on port ${port_no} với cấu hình từ Key Vault!`);
    });

  } catch (err) {
    console.error("❌ Không thể khởi động server do lỗi:", err);
    process.exit(1);
  }
}

// Gọi hàm khởi động
startServer();

// ==========================================
// CÁC LOGIC API VÀ SOCKET.IO
// ==========================================

app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));

app.get("/", (req, res) => {
  res.send("🚀 Skribbl Game Backend API is running successfully!");
});

app.get("/api/history", async (req, res) => {
  try {
    const cacheKey = "match_history";
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return res.json({ source: "Redis Cache ⚡", data: JSON.parse(cached) });
    }
    const result = await pool.query("SELECT * FROM match_history ORDER BY created_at DESC LIMIT 10");
    await redisClient.setEx(cacheKey, 60, JSON.stringify(result.rows)); 
    res.json({ source: "PostgreSQL 🐘", data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload-drawing", async (req, res) => {
  try {
    const { imageBase64, roomCode, username } = req.body;
    if (!blobServiceClient) {
      return res.status(400).json({ success: false, message: "Chưa cấu hình Blob Storage!" });
    }
    if (!imageBase64) return res.status(400).json({ success: false, message: "Thiếu dữ liệu hình ảnh!" });

    const containerClient = blobServiceClient.getContainerClient("drawings");
    await containerClient.createIfNotExists({ access: "blob" });
    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    const buffer = Buffer.from(matches ? matches[2] : imageBase64, "base64");
    const blobName = `drawing_${roomCode || "room"}_${Date.now()}.png`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(buffer, { blobHTTPHeaders: { blobContentType: "image/png" } });
    return res.json({ success: true, imageUrl: blockBlobClient.url });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

// LOGIC SOCKET GAME
const sampleWords = ["con mèo", "ngôi nhà", "xe máy", "mặt trời", "cây cối", "máy tính", "bánh mì", "con cá", "trái đất", "hoa hồng", "điện thoại"];
const rooms = {};

function getRandomWordsServer(room) {
  let pool = [...sampleWords];
  if (room && room.customWords && room.customWords.length > 0) {
    pool = [...room.customWords, ...sampleWords];
  }
  const shuffled = pool.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 3);
}

const startGame = (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return;
  console.log(`🎮 [GAME START] Trận đấu tại phòng [${roomCode}] đã bắt đầu!`);
  room.gameStarted = true;
  io.to(roomCode).emit("game-start", {});
  startTurn(roomCode);
};

const stopGame = (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return;
  console.log(`🛑 [GAME STOP] Trận đấu tại phòng [${roomCode}] đã dừng.`);
  io.to(roomCode).emit("game-stop", {});
  room.drawerindex = 0;
  room.gameStarted = false;
  room.word = "";
  if (room.timeout) { clearTimeout(room.timeout); room.timeout = null; }
};

const startTurn = (roomCode) => {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) return;
  if (room.drawerindex >= room.players.length) room.drawerindex = 0;
  room.word = "";
  const currentDrawer = room.players[room.drawerindex];
  console.log(`🎨 [TURN START] Lượt vẽ của người chơi: ${currentDrawer.name} (phòng ${roomCode})`);
  io.to(roomCode).emit("start-turn", currentDrawer);
  const wordsForDrawer = getRandomWordsServer(room);
  io.to(currentDrawer.id).emit("receive-words", wordsForDrawer);
};

const startDraw = (roomCode) => {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) return;
  io.to(roomCode).emit("start-draw", room.players[room.drawerindex]);
  if (room.timeout) clearTimeout(room.timeout);
  room.timeout = setTimeout(() => endTurn(roomCode), 60000);
};

const endTurn = (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return;
  if (room.timeout) clearTimeout(room.timeout);
  room.word = "";
  io.to(roomCode).emit("end-turn", room.players[room.drawerindex]);
  room.playerGuessedRightWord = [];
  
  if (room.players.length > 0) {
    room.drawerindex++;
    if (room.drawerindex >= room.players.length) {
      room.drawerindex = 0;
      room.currentRound++;
    }
    if (room.currentRound > room.maxRounds) {
      console.log(`🏆 [GAME OVER] Phòng [${roomCode}] hoàn tất trận đấu. Đang lưu điểm vào Database...`);
      room.players.forEach(player => {
        if (pool) {
          pool.query('INSERT INTO match_history(room_code, player_name, score) VALUES($1, $2, $3)', [roomCode, player.name, player.points], (err) => {
            if (err) console.error("❌ Lỗi lưu điểm vào PostgreSQL:", err);
          });
        }
      });
      io.to(roomCode).emit("game-ended-leaderboard", room.players);
      stopGame(roomCode);
    } else {
      startTurn(roomCode);
    }
  } else {
    stopGame(roomCode);
  }
};

// ==========================================
// LẮNG NGHE SỰ KIỆN KẾT NỐI TỪ CLIENT
// ==========================================
io.on("connection", (socket) => {
  console.log("🔌 Connected to socket.io:", socket.id);
  
  // Gửi thông báo yêu cầu dữ liệu người dùng ngay khi vừa kết nối
  socket.emit("send-user-data", {});

  const handleUserData = ({ username, avatar, roomCode }) => {
    console.log(`📩 [NHẬN DATA USER] Socket ID: ${socket.id} | User: ${username} | Room gửi lên: "${roomCode}"`);

    let actualRoomCode = (roomCode && typeof roomCode === "string" && roomCode.trim() !== "")
      ? roomCode.trim().toUpperCase() 
      : Math.random().toString(36).substring(2, 7).toUpperCase();

    // Socket.io Native join room tức thì (đồng bộ)
    socket.join(actualRoomCode);
    socket.roomCode = actualRoomCode;

    if (!rooms[actualRoomCode]) {
      rooms[actualRoomCode] = { 
        hostId: socket.id, players: [], drawerindex: 0, word: "", 
        timeout: null, playerGuessedRightWord: [], gameStarted: false,
        currentRound: 1, maxRounds: 3, customWords: []
      };
      console.log(`🎉 [TẠO PHÒNG MỚI] Mã phòng: ${actualRoomCode} | Host: ${username}`);
    }

    const currentRoom = rooms[actualRoomCode];
    const existingIndex = currentRoom.players.findIndex(p => p.id === socket.id);
    if (existingIndex === -1) {
      currentRoom.players.push({ id: socket.id, name: username || "Guest", points: 0, avatar: avatar || "1" });
    } else {
      currentRoom.players[existingIndex].name = username || "Guest";
      currentRoom.players[existingIndex].avatar = avatar || "1";
    }

    console.log(`✅ [PHÒNG ${actualRoomCode}] Danh sách hiện tại (${currentRoom.players.length} người):`, 
      currentRoom.players.map(p => p.name).join(", "));

    // Báo mã phòng cho Client
    socket.emit("room-assigned", actualRoomCode);
    
    // Broadcast danh sách người chơi ngay lập tức
    io.to(actualRoomCode).emit("updated-players", { players: currentRoom.players, hostId: currentRoom.hostId });
  };

  // Đăng ký cả 2 tên event
  socket.on("receive-user-data", handleUserData);
  socket.on("recieve-user-data", handleUserData);

  socket.on("host-start-game", (config) => {
    const room = rooms[socket.roomCode];
    if (room && room.hostId === socket.id && room.players.length >= 1 && !room.gameStarted) {
      room.maxRounds = config?.maxRounds || 3;
      room.customWords = config?.customWords || [];
      room.currentRound = 1; 
      room.players.forEach(p => p.points = 0);
      io.to(socket.roomCode).emit("updated-players", { players: room.players, hostId: room.hostId });
      startGame(socket.roomCode);
    }
  });

  socket.on("return-to-lobby", () => {
    const room = rooms[socket.roomCode];
    if (room && room.hostId === socket.id) {
      stopGame(socket.roomCode);
      io.to(socket.roomCode).emit("close-leaderboard");
      io.to(socket.roomCode).emit("updated-players", { players: room.players, hostId: room.hostId });
    }
  });

  socket.on("sending", (data) => {
    if (socket.roomCode) socket.to(socket.roomCode).emit("receiving", data);
  });

  socket.on("sending-chat", (inputMessage) => {
    const room = rooms[socket.roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    let rightGuess = false;

    if (room.word && inputMessage && inputMessage.toLowerCase() === room.word.toLowerCase()) {
      rightGuess = true;
      player.points += 100;
    }
    io.to(socket.roomCode).emit("recieve-chat", { msg: inputMessage, player, rightGuess, players: room.players });

    if (rightGuess && !room.playerGuessedRightWord.includes(socket.id)) {
      room.playerGuessedRightWord.push(socket.id);
      if (room.playerGuessedRightWord.length === room.players.length - 1) {
        io.to(socket.roomCode).emit("all-guessed-correct", {});
        room.playerGuessedRightWord = [];
        endTurn(socket.roomCode);
      }
    }
  });

  socket.on("word-select", (word) => {
    const room = rooms[socket.roomCode];
    if (room) {
      room.word = word;
      console.log(`📝 [CHỌN TỪ] Phòng [${socket.roomCode}] chọn từ: "${word}"`);
      io.to(socket.roomCode).emit("word-len", word.length);
      startDraw(socket.roomCode);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`❌ Disconnected: ${socket.id} | Lý do: ${reason}`);
    if (socket.roomCode && rooms[socket.roomCode]) {
      const room = rooms[socket.roomCode];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index > -1) {
        room.players.splice(index, 1);
        if (room.hostId === socket.id && room.players.length > 0) room.hostId = room.players[0].id;
        io.to(socket.roomCode).emit("updated-players", { players: room.players, hostId: room.hostId });
        if (room.players.length <= 1 && room.gameStarted) stopGame(socket.roomCode);
        if (room.players.length === 0) {
          if (room.timeout) clearTimeout(room.timeout);
          delete rooms[socket.roomCode];
          console.log(`🧹 [XÓA PHÒNG] Phòng [${socket.roomCode}] không còn ai nên đã bị giải phóng.`);
        }
      }
    }
  });
});