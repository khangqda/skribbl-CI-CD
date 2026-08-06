const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { getSecret } = require("./keyvault");

async function startServer() {
  try {
    // 1. Lấy chuỗi kết nối từ "két sắt" Key Vault
    const dbConnectionString = await getSecret("DB-CONNECTION-STRING");
    const redisConnectionString = await getSecret("REDIS-CONNECTION-STRING");

    // 2. Dùng chuỗi kết nối này để khởi tạo kết nối DB / Redis
    // (Ví dụ: connectDatabase(dbConnectionString);)

    console.log("🚀 Server sẵn sàng hoạt động với cấu hình từ Key Vault!");
  } catch (err) {
    console.error("Không thể khởi động server do lỗi Key Vault:", err);
  }
}

startServer();
const dotenv = require("dotenv");
dotenv.config();
const { ServiceBusClient } = require("@azure/service-bus");

// Hàm test kết nối và gửi tin nhắn lên Azure Service Bus
async function testServiceBus() {
  const connectionString = process.env.SERVICEBUS_CONNECTION_STRING;
  if (!connectionString) return;

  try {
    const sbClient = new ServiceBusClient(connectionString);
    // Kết nối tới Queue tên 'test-skribbl-queue' vừa tạo
    const sender = sbClient.createSender("test-skribbl-queue");

    // Gửi 1 tin nhắn test
    await sender.sendMessages({
      body: { message: "Hello từ Skribbl Game!", timestamp: new Date() }
    });

    console.log("🚌 [Service Bus] Đã kết nối & gửi tin nhắn test thành công!");

    await sender.close();
    await sbClient.close();
  } catch (err) {
    console.error("❌ [Service Bus] Lỗi:", err.message);
  }
}

// Gọi hàm test
testServiceBus();
const { BlobServiceClient } = require("@azure/storage-blob");
const { Pool } = require("pg"); // ✅ ĐÃ THÊM: Thư viện PostgreSQL

const server = http.createServer(app);

// ✅ ĐÃ THÊM: Cấu hình kết nối Azure PostgreSQL
const pool = new Pool({
  // 🚨 BÁC CHỈ CẦN SỬA ĐÚNG DÒNG NÀY: Thay chữ <ĐIỀN_MẬT_KHẨU_Ở_ĐÂY> bằng password thật của bác (giữ nguyên các phần khác)
    connectionString: "postgres://acce:EtHvIqN42knSuKH3e%2FY0yEwzvKkpUvLMz%2B2ApP1%2BEK%2BsZmO2cm9Qh9ICZm3tRO6VxdhvNTCcUbQt%2BAStZ9dY%2BQ%3D%3D@skribbl-db-aug2026.postgres.database.azure.com/postgres?sslmode=require",  ssl: {
    rejectUnauthorized: false
  }
});
const { createClient } = require("redis");

// Khởi tạo Redis Client
const redisClient = createClient({
  url: `rediss://default:${process.env.REDIS_KEY}@${process.env.REDIS_HOST}:10000`
});

redisClient.on("error", (err) => console.error("❌ Lỗi Redis:", err));
redisClient.on("connect", () => console.log("⚡ Đã kết nối Azure Managed Redis!"));

// Bắt đầu kết nối
redisClient.connect().catch(console.error);

// ✅ ĐÃ THÊM: Tự động kết nối và tạo bảng lưu điểm
pool.connect((err, client, release) => {
  if (err) {
    console.error("❌ Lỗi kết nối Azure PostgreSQL:", err.stack);
  } else {
    console.log("🐘 Đã kết nối thành công với Azure PostgreSQL!");
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS match_history (
        id SERIAL PRIMARY KEY,
        room_code VARCHAR(50),
        player_name VARCHAR(100),
        score INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    client.query(createTableQuery, (err, result) => {
      if (err) console.error("❌ Lỗi tạo bảng:", err);
      else console.log("✅ Bảng match_history đã sẵn sàng!");
      release(); 
    });
  }
});

const io = new Server(server, {
  pingTimeout: 60000,
  cors: {
    origin: "*", 
    methods: ["GET", "POST"],
  },
  connectionStateRecovery: {},
  transports: ["polling", "websocket"] 
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));


app.get("/", (req, res) => {
  res.send("🚀 Skribbl Game Backend API is running successfully!");
});

const port_no = process.env.PORT || 3001;
server.listen(port_no, () => {
  console.log(`Server listening on port ${port_no}`);
});

const sampleWords = [
  "con mèo", "ngôi nhà", "xe máy", "mặt trời", "cây cối", 
  "máy tính", "bánh mì", "con cá", "trái đất", "hoa hồng", "điện thoại"
];

function getRandomWordsServer(room) {
  let pool = [...sampleWords];
  if (room && room.customWords && room.customWords.length > 0) {
    pool = [...room.customWords, ...sampleWords];
  }
  const shuffled = pool.sort(() => 0.5 - Math.random());
  return shuffled.slice(0, 3);
}

const rooms = {};

const startGame = (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return;
  room.gameStarted = true;
  console.log("Game started in room: " + roomCode);
  io.to(roomCode).emit("game-start", {});
  startTurn(roomCode);
};

const stopGame = (roomCode) => {
  const room = rooms[roomCode];
  if (!room) return;
  console.log("Game stopped in room: " + roomCode);
  io.to(roomCode).emit("game-stop", {});
  room.drawerindex = 0;
  room.gameStarted = false;
  room.word = "";
  if (room.timeout) {
    clearTimeout(room.timeout);
    room.timeout = null;
  }
};

const startTurn = (roomCode) => {
  const room = rooms[roomCode];
  if (!room || room.players.length === 0) return;
  if (room.drawerindex >= room.players.length) room.drawerindex = 0;

  room.word = "";
  const currentDrawer = room.players[room.drawerindex];

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
      console.log(`Phòng ${roomCode} đã hoàn thành ${room.maxRounds} vòng chơi. Kết thúc game!`);
      
      // ✅ ĐÃ THÊM: Lưu điểm vào Database khi hết game
      room.players.forEach(player => {
        const insertQuery = 'INSERT INTO match_history(room_code, player_name, score) VALUES($1, $2, $3)';
        const values = [roomCode, player.name, player.points];
        pool.query(insertQuery, values, (err, res) => {
          if (err) console.error("❌ Lỗi lưu điểm:", err);
        });
      });
      console.log("💾 Đã lưu lịch sử trận đấu lên Database Azure!");

      io.to(roomCode).emit("game-ended-leaderboard", room.players);
      stopGame(roomCode);
    } else {
      startTurn(roomCode);
    }
  } else {
    stopGame(roomCode);
  }
};

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
let blobServiceClient;
if (AZURE_STORAGE_CONNECTION_STRING) {
  blobServiceClient = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
}

app.post("/api/upload-drawing", async (req, res) => {
  try {
    const { imageBase64, roomCode, username } = req.body;

    if (!AZURE_STORAGE_CONNECTION_STRING || !blobServiceClient) {
      return res.status(400).json({ 
        success: false, 
        message: "Chưa cấu hình AZURE_STORAGE_CONNECTION_STRING ở Server!" 
      });
    }

    if (!imageBase64) {
      return res.status(400).json({ success: false, message: "Thiếu dữ liệu hình ảnh!" });
    }

    const containerClient = blobServiceClient.getContainerClient("drawings");
    await containerClient.createIfNotExists({ access: "blob" });

    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    const buffer = Buffer.from(matches ? matches[2] : imageBase64, "base64");

    const blobName = `drawing_${roomCode || "room"}_${Date.now()}.png`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: { blobContentType: "image/png" }
    });

    console.log("Upload ảnh lên Azure Blob thành công:", blockBlobClient.url);

    return res.json({
      success: true,
      imageUrl: blockBlobClient.url,
      message: "Lưu bức tranh lên Azure Blob Storage thành công!"
    });
  } catch (error) {
    console.error("Lỗi upload ảnh:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});
//Tích hợp cache cho Redis để tăng tốc độ truy xuất lịch sử trận đấu
app.get("/api/history", async (req, res) => {
  try {
    const cacheKey = "match_history";
    
    // 1. Vào RAM (Redis) tìm trước xem có không
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log("🚀 Lấy từ Redis siêu tốc!");
      return res.json({ source: "Redis Cache ⚡", data: JSON.parse(cached) });
    }

    // 2. Nếu Redis trống, mới phải lóc cóc vào PostgreSQL lấy
    console.log("🐢 Trượt Cache, vào PostgreSQL lấy...");
    const result = await pool.query("SELECT * FROM match_history ORDER BY created_at DESC LIMIT 10");
    
    // 3. Lưu bản sao vào Redis trong vòng 60 giây
    await redisClient.setEx(cacheKey, 60, JSON.stringify(result.rows)); 
    
    res.json({ source: "PostgreSQL 🐘", data: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

io.on("connection", (socket) => {
  console.log("Connected to socket.io:", socket.id);
  io.to(socket.id).emit("send-user-data", {});

  socket.on("recieve-user-data", ({ username, avatar, roomCode }) => {
    let actualRoomCode = (roomCode && typeof roomCode === "string" && roomCode.trim() !== "")
      ? roomCode.toUpperCase()
      : Math.random().toString(36).substring(2, 7).toUpperCase();
    socket.join(actualRoomCode);
    socket.roomCode = actualRoomCode;

    if (!rooms[actualRoomCode]) {
      rooms[actualRoomCode] = { 
        hostId: socket.id,
        players: [], 
        drawerindex: 0, 
        word: "", 
        timeout: null, 
        playerGuessedRightWord: [], 
        gameStarted: false,
        currentRound: 1,
        maxRounds: 3,
        customWords: []
      };
    }

    const currentRoom = rooms[actualRoomCode];
    const existingIndex = currentRoom.players.findIndex(p => p.id === socket.id);
    if (existingIndex === -1) {
      currentRoom.players.push({ id: socket.id, name: username, points: 0, avatar: avatar });
    } else {
      currentRoom.players[existingIndex].name = username;
      currentRoom.players[existingIndex].avatar = avatar;
    }

    socket.emit("room-assigned", actualRoomCode);
    
    io.to(actualRoomCode).emit("updated-players", {
      players: currentRoom.players,
      hostId: currentRoom.hostId
    });

    if (currentRoom.gameStarted) {
      socket.emit("game-already-started");
      const currentDrawer = currentRoom.players[currentRoom.drawerindex];
      if (currentDrawer) {
        socket.emit("start-turn", currentDrawer);
        if (currentRoom.word) {
          socket.emit("word-len", currentRoom.word.length);
          socket.emit("start-draw", currentDrawer);
        }
      }
    }
  });

  socket.on("host-start-game", (config) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (room && room.hostId === socket.id && room.players.length >= 2 && !room.gameStarted) {
      room.maxRounds = config?.maxRounds || 3;
      room.customWords = config?.customWords || [];
      room.currentRound = 1; 
      room.players.forEach(p => p.points = 0);
      
      io.to(roomCode).emit("updated-players", {
        players: room.players,
        hostId: room.hostId
      });

      startGame(roomCode);
    }
  });

  socket.on("return-to-lobby", () => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (room && room.hostId === socket.id) {
      stopGame(roomCode);
      io.to(roomCode).emit("close-leaderboard");
      io.to(roomCode).emit("updated-players", {
        players: room.players,
        hostId: room.hostId
      });
    }
  });

  socket.on("sending", (data) => {
    const roomCode = socket.roomCode;
    if (roomCode) socket.to(roomCode).emit("receiving", data);
  });

  socket.on("sending-chat", (inputMessage) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    const index = room.players.findIndex(p => p.id === socket.id);
    if (index === -1) return;
    const player = room.players[index];
    let rightGuess = false;

    if (room.word && inputMessage && inputMessage.toLowerCase() === room.word.toLowerCase()) {
      rightGuess = true;
      player.points += 100;
    }
    io.to(roomCode).emit("recieve-chat", { msg: inputMessage, player, rightGuess, players: room.players });

    if (rightGuess && !room.playerGuessedRightWord.includes(socket.id)) {
      room.playerGuessedRightWord.push(socket.id);
      if (room.playerGuessedRightWord.length === room.players.length - 1) {
        io.to(roomCode).emit("all-guessed-correct", {});
        room.playerGuessedRightWord = [];
        endTurn(roomCode);
      }
    }
  });

  socket.on("word-select", (word) => {
    const roomCode = socket.roomCode;
    const room = rooms[roomCode];
    if (room) {
      room.word = word;
      io.to(roomCode).emit("word-len", word.length);
      startDraw(roomCode);
    }
  });

  socket.on("disconnect", () => {
    const roomCode = socket.roomCode;
    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index > -1) {
        room.players.splice(index, 1);
        
        if (room.hostId === socket.id && room.players.length > 0) {
          room.hostId = room.players[0].id;
        }

        io.to(roomCode).emit("updated-players", {
          players: room.players,
          hostId: room.hostId
        });

        if (room.players.length <= 1) stopGame(roomCode);
        if (room.players.length === 0) {
          if (room.timeout) clearTimeout(room.timeout);
          delete rooms[roomCode];
        }
      }
    }
  });
});