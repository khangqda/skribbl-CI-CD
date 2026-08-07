import React, { useEffect, useState, useRef } from "react";
import { io } from "socket.io-client";
import { Buffer } from "buffer";
import PlayerCard from "../components/PlayerCard";
import WordBar from "../components/WordBar";
import { useNavigate, useLocation } from "react-router-dom";

function PlayScreen() {
  const canvasRef = useRef(null);
  const [maxRounds, setMaxRounds] = useState(3);
  const [customWordsInput, setCustomWordsInput] = useState("");
  const currentRoomCodeRef = useRef("");
  const [isPainting, setIsPainting] = useState(false);
  const [mousePosition, setMousePosition] = useState(undefined);
  const [color, setColor] = useState("#000000");
  const [startPoint, setStartPoint] = useState(null);
  const [lines, setLines] = useState([]);
  const [straightLineMode, setStraightLineMode] = useState(false);
  const [radius, setRadius] = useState(5);
  const [isEraser, setIsEraser] = useState(false);
  const [inputMessage, setInputMessage] = useState("");
  const [allChats, setAllChats] = useState([]);
  const [allPlayers, setAllPlayer] = useState([]);
  const [socket, setSocket] = useState(null);
  const [currentUserDrawing, setCurrentUserDrawing] = useState(false);
  const [gameStarted, setgameStarted] = useState(false);
  const [playerDrawing, setPlayerDrawing] = useState(null);
  const [showWords, setShowWords] = useState(false);
  const [words, setWords] = useState([]);
  const [selectedWord, setSelectedWord] = useState(null);
  const [showClock, setShowClock] = useState(false);
  const [wordLen, setWordLen] = useState(0);
  const [guessedWord, setGuessedWord] = useState(false);
  const [currentRoomCode, setCurrentRoomCode] = useState("");
  const [hostId, setHostId] = useState("");
  const [leaderboardData, setLeaderboardData] = useState(null);
  
  const navigate = useNavigate();
  const location = useLocation();
  const userDataRecieved = location.state || {};

  // URL Backend
  const BACKEND_URL = "https://skribbl-game-bjc3gwb7dygyg2e2.japaneast-01.azurewebsites.net";

  useEffect(() => {
    // 1. Lấy thông tin User
    const us = userDataRecieved.username || localStorage.getItem("username") || "khang";
    let av = userDataRecieved.avatar || localStorage.getItem("avatar") || "1";

    if (av && (av.length > 100 || av.startsWith("data:image"))) {
      av = "1";
    }

    // 2. Lấy roomCode từ các nguồn (Nếu không có, để rỗng để server tự cấp phòng mới)
    let roomCodeFromHome =
      userDataRecieved.roomCode ||
      userDataRecieved.room ||
      userDataRecieved.code ||
      userDataRecieved.roomId ||
      localStorage.getItem("roomCode") ||
      "";

    console.log("🚀 [PLAYSCREEN] Đang khởi tạo Socket kết nối tới App Service...");

    const newSocket = io(BACKEND_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
    });

    // Hàm gửi dữ liệu User lên Server
    const sendUserData = () => {
      const activeRoomCode = currentRoomCodeRef.current || roomCodeFromHome;

      const payload = {
        username: us,
        avatar: av,
        roomCode: activeRoomCode,
      };

      console.log("📤 [SOCKET EMIT] Gửi thông tin user:", payload);

      // Bắn cả 2 kiểu viết chính tả để đảm bảo 100% khớp với Backend của bạn
      newSocket.emit("receive-user-data", payload);
      newSocket.emit("recieve-user-data", payload);
    };

    newSocket.on("connect", () => {
      console.log("🟢 [SOCKET CONNECTED] Socket ID:", newSocket.id);
      setTimeout(() => {
        sendUserData();
      }, 150);
    });

    // Lắng nghe yêu cầu lấy thông tin từ Server
    newSocket.on("send-user-data", () => sendUserData());
    newSocket.on("get-user-data", () => sendUserData());

    // Nhận thông tin gán phòng từ Server
    newSocket.on("room-assigned", (code) => {
      console.log("🎉 [ROOM ASSIGNED] Đã nhận roomCode thành công:", code);
      setCurrentRoomCode(code);
      currentRoomCodeRef.current = code;
      localStorage.setItem("roomCode", code);
    });

    // Cập nhật danh sách người chơi
    newSocket.on("updated-players", (data) => {
      console.log("👥 [UPDATED PLAYERS]:", data);
      if (data && data.players) {
        setAllPlayer(data.players);
        setHostId(data.hostId);
      } else if (Array.isArray(data)) {
        setAllPlayer(data);
      }
    });

    // Các sự kiện vẽ & chat
    newSocket.on("receiving", async (data) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");

      const base64String = data.split(",")[1];
      const buffer = Buffer.from(base64String, "base64");
      const byteArray = new Uint8Array(buffer);
      const blob = new Blob([byteArray], { type: "image/png" });
      const imageUrl = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      };
      img.src = imageUrl;
    });

    newSocket.on("game-start", () => setgameStarted(true));
    newSocket.on("game-already-started", () => setgameStarted(true));
    newSocket.on("game-stop", () => {
      setgameStarted(false);
      setShowClock(false);
      setCurrentUserDrawing(false);
      setPlayerDrawing(null);
    });

    newSocket.on("start-turn", (player) => {
      setGuessedWord(false);
      clearCanvasAfterTurn();
      setPlayerDrawing(player);
      setShowWords(false);
      setCurrentUserDrawing(false);
    });

    newSocket.on("receive-words", (serverWords) => {
      setWords(serverWords);
      setShowWords(true);
    });

    newSocket.on("word-len", (wl) => setWordLen(wl));

    newSocket.on("start-draw", (player) => {
      setShowWords(false);
      setShowClock(true);
      clearCanvasAfterTurn();
      const isMeDrawing = Boolean(player && newSocket && player.id === newSocket.id);
      setCurrentUserDrawing(isMeDrawing);
    });

    newSocket.on("end-turn", () => {
      setGuessedWord(false);
      setPlayerDrawing(null);
      setShowClock(false);
      setSelectedWord(null);
      setCurrentUserDrawing(false);
    });

    newSocket.on("recieve-chat", ({ msg, player, rightGuess, players }) => {
      if (players) setAllPlayer(players);
      if (rightGuess) {
        if (player.id === newSocket.id) {
          setGuessedWord(true);
          setAllChats((prev) => [
            { sender: "you", message: `you guessed the right word! (${msg})`, rightGuess },
            ...prev,
          ]);
        } else {
          setAllChats((prev) => [
            { sender: player.name, message: `${player.name} guessed the word right!`, rightGuess },
            ...prev,
          ]);
        }
      } else {
        setAllChats((prev) => [
          { sender: player.id === newSocket.id ? "you" : player.name, message: msg, rightGuess },
          ...prev,
        ]);
      }
    });

    newSocket.on("game-ended-leaderboard", (finalPlayers) => {
      const sortedPlayers = [...finalPlayers].sort((a, b) => b.points - a.points);
      setLeaderboardData(sortedPlayers);
      setgameStarted(false);
    });

    newSocket.on("close-leaderboard", () => {
      setLeaderboardData(null);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    ctx.lineCap = "round";
    ctx.lineWidth = radius;
    ctx.strokeStyle = color;
  }, [color, radius]);

  const startPaint = (event) => {
    if (!currentUserDrawing) return;
    const coordinates = getCoordinates(event);
    if (coordinates) {
      setIsPainting(true);
      setMousePosition(coordinates);
      if (straightLineMode) setStartPoint(coordinates);
    }
  };

  const paint = (event) => {
    if (!isPainting || straightLineMode) return;
    const newMousePosition = getCoordinates(event);
    if (mousePosition && newMousePosition) {
      if (isEraser) eraseLine(newMousePosition);
      else drawLine(newMousePosition);
      setMousePosition(newMousePosition);
    }
  };

  const exitPaint = () => {
    setIsPainting(false);
    setMousePosition(undefined);
    setStartPoint(null);
  };

  const getCoordinates = (event) => {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  };

  const drawLine = async (position) => {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    context.strokeStyle = color;
    context.beginPath();
    context.moveTo(mousePosition.x, mousePosition.y);
    context.lineTo(position.x, position.y);
    context.lineWidth = radius;
    context.stroke();

    const dataURL = canvas.toDataURL("image/png");
    if (socket) socket.emit("sending", dataURL);
    setLines((prev) => [...prev, { start: mousePosition, end: position, color, radius }]);
    setMousePosition(position);
  };

  const handleMouseUp = (event) => {
    if (straightLineMode && startPoint) drawStraightLine(event);
    exitPaint();
  };

  const drawStraightLine = async (event) => {
    if (straightLineMode && startPoint) {
      const endPoint = getCoordinates(event);
      const canvas = canvasRef.current;
      const context = canvas.getContext("2d");

      context.strokeStyle = color;
      context.lineWidth = radius;
      context.beginPath();
      context.moveTo(startPoint.x, startPoint.y);
      context.lineTo(endPoint.x, endPoint.y);
      context.stroke();

      const dataURL = canvas.toDataURL("image/png");
      if (socket) socket.emit("sending", dataURL);
      setStartPoint(null);
    }
  };

  const eraseLine = async (position) => {
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    const imageData = context.getImageData(
      position.x - radius,
      position.y - radius,
      2 * radius,
      2 * radius
    );
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i + 3] = 0;
    }
    context.putImageData(imageData, position.x - radius, position.y - radius);

    const dataURL = canvas.toDataURL("image/png");
    if (socket) socket.emit("sending", dataURL);
  };

  const fillCanvas = async () => {
    if (!currentUserDrawing) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    context.fillStyle = color;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const dataURL = canvas.toDataURL("image/png");
    if (socket) socket.emit("sending", dataURL);
  };

  const clearCanvas = async () => {
    if (!currentUserDrawing) return;
    const canvas = canvasRef.current;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    setLines([]);
    const dataURL = canvas.toDataURL("image/png");
    if (socket) socket.emit("sending", dataURL);
  };

  const clearCanvasAfterTurn = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
    }
  };

  const handleSubmitForm = (e) => {
    e.preventDefault();
    if (!inputMessage || !socket) return;
    socket.emit("sending-chat", inputMessage.toLowerCase());
    setInputMessage("");
  };

  const handleWorSelect = (w) => {
    setShowWords(false);
    setSelectedWord(w);
    if (socket) socket.emit("word-select", w);
    setWords([]);
  };

  const handleStartGameClick = () => {
    if (socket) {
      const customWordsArray = customWordsInput
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w.length > 0);

      socket.emit("host-start-game", {
        maxRounds: maxRounds,
        customWords: customWordsArray,
      });
    }
  };

  const handleSaveDrawing = async () => {
    if (!canvasRef.current) return;
    const imageBase64 = canvasRef.current.toDataURL("image/png");

    try {
      const response = await fetch(`${BACKEND_URL}/api/upload-drawing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64,
          roomCode: currentRoomCode,
          username: userDataRecieved.username || localStorage.getItem("username") || "Anonymous",
        }),
      });

      const data = await response.json();
      if (response.ok && data.success) {
        alert("🎉 ĐÃ LƯU BỨC TRANH LÊN AZURE BLOB STORAGE!\n\nLink ảnh: " + data.imageUrl);
        if (data.imageUrl) window.open(data.imageUrl, "_blank");
      } else {
        alert("❌ Lỗi: " + (data.message || "Không thể lưu ảnh"));
      }
    } catch (err) {
      console.error(err);
      alert("❌ Lỗi kết nối Server khi lưu ảnh!");
    }
  };

  const basicColors = [
    "#000000", "#FF0000", "#00FF00", "#0000FF", "#FFFF00",
    "#FF00FF", "#00FFFF", "#C0C0C0", "#808080", "#FFFFFF",
  ];

  return (
    <div className="relative w-screen h-screen">
      <div className="w-full h-full flex flex-col justify-center items-center gap-4">
        <div className="flex items-center gap-2 bg-slate-800 text-yellow-400 px-5 py-2 rounded-full border-2 border-yellow-400 shadow-lg">
          <span className="font-bold text-sm tracking-wider">MÃ PHÒNG:</span>
          <span className="text-white font-mono font-extrabold text-xl tracking-widest select-all">
            {currentRoomCode || "Đang kết nối / Tạo phòng..."}
          </span>
        </div>

        <div>
          <WordBar
            showClock={showClock}
            wordLen={wordLen}
            gameStarted={gameStarted}
            showWords={showWords}
            currentUserDrawing={currentUserDrawing}
            selectedWord={selectedWord}
          />
        </div>

        <div className="w-full flex justify-center items-center gap-10">
          <div className="w-[300px] h-[540px] border border-black bg-white text-black overflow-y-auto">
            {allPlayers &&
              allPlayers.map((pl, idx) => (
                <PlayerCard
                  key={idx}
                  pl={pl}
                  curruser={socket && pl.id === socket.id}
                  playerDrawing={playerDrawing}
                />
              ))}
          </div>

          <div className="w-[680px] h-[540px] relative">
            <canvas
              ref={canvasRef}
              width={680}
              height={540}
              onMouseDown={startPaint}
              onMouseMove={paint}
              onMouseUp={handleMouseUp}
              onMouseLeave={exitPaint}
              className={`border border-black bg-white ${
                currentUserDrawing ? "cursor-crosshair" : "cursor-not-allowed"
              }`}
            />

            {!gameStarted && (
              <div className="absolute top-0 left-0 w-full h-full bg-slate-900 bg-opacity-95 flex flex-col justify-center items-center text-white z-20 rounded-lg p-6">
                <h2 className="text-3xl font-extrabold mb-4 text-yellow-400">PHÒNG CHỜ</h2>
                <p className="text-gray-300 mb-6 font-semibold text-lg">
                  Số người chơi trong phòng: {allPlayers.length}/8
                </p>

                {/* NÚT TỰ DO KÍCH HOẠT DÀNH CHO TEST KHI LỖI LOBBY */}
                {allPlayers.length === 0 && (
                  <button
                    onClick={() => {
                      if (socket) {
                        socket.emit("receive-user-data", { username: "khang", avatar: "1", roomCode: "" });
                        socket.emit("recieve-user-data", { username: "khang", avatar: "1", roomCode: "" });
                      }
                    }}
                    className="mb-4 text-xs bg-yellow-600 px-3 py-1 rounded text-white"
                  >
                    🔄 Bấm vào đây nếu không thấy Tên người chơi
                  </button>
                )}

                {socket && (socket.id === hostId || allPlayers.length <= 1) ? (
                  <div className="w-full max-w-md bg-slate-800 p-4 rounded-xl mb-6 shadow-lg border border-slate-700">
                    <label className="block text-sm font-bold mb-2 text-sky-300">
                      SỐ VÒNG CHƠI (ROUNDS): {maxRounds}
                    </label>
                    <input
                      type="range"
                      min="1"
                      max="10"
                      value={maxRounds}
                      onChange={(e) => setMaxRounds(parseInt(e.target.value))}
                      className="w-full mb-4 accent-sky-500"
                    />
                  </div>
                ) : (
                  <div className="w-full max-w-md bg-slate-800 p-6 rounded-xl mb-6 text-center border border-slate-700">
                    <p className="text-xl animate-pulse text-sky-300 font-bold">
                      Đang chờ Chủ phòng cài đặt trận đấu...
                    </p>
                  </div>
                )}

                {socket && (socket.id === hostId || allPlayers.length >= 1) && (
                  <button
                    onClick={handleStartGameClick}
                    className="px-8 py-3 bg-green-500 hover:bg-green-600 text-white rounded-full font-bold text-lg shadow-lg cursor-pointer transition-transform hover:scale-105"
                  >
                    BẮT ĐẦU TRẬN ĐẤU
                  </button>
                )}
              </div>
            )}

            <div>
              {showWords && playerDrawing && socket && playerDrawing.id === socket.id && (
                <div className="absolute top-0 left-0 h-full w-full flex flex-col justify-center items-center z-10 bg-white bg-opacity-95 rounded-lg shadow-2xl border-4 border-sky-300">
                  <h3 className="text-2xl font-extrabold mb-6 text-slate-800">CHỌN 1 TỪ ĐỂ VẼ</h3>
                  <div className="flex gap-6 mb-8">
                    {words.map((w, idx) => (
                      <div
                        onClick={() => handleWorSelect(w)}
                        key={idx}
                        className="text-black text-center font-bold px-6 py-3 text-lg border-2 rounded-xl border-slate-700 cursor-pointer hover:bg-yellow-300 hover:scale-105 transition-all shadow-md"
                      >
                        {w}
                      </div>
                    ))}
                  </div>

                  <div className="flex items-center gap-3 bg-slate-100 p-4 rounded-xl shadow-inner border border-slate-300">
                    <span className="font-bold text-slate-600">Hoặc tự nhập:</span>
                    <input
                      type="text"
                      id="customDrawerWord"
                      placeholder="VD: con chó, hoa sen..."
                      className="px-4 py-2 rounded-lg border-2 border-slate-400 focus:border-sky-500 text-black"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && e.target.value.trim()) {
                          handleWorSelect(e.target.value.trim());
                        }
                      }}
                    />
                    <button
                      onClick={() => {
                        const val = document.getElementById("customDrawerWord").value.trim();
                        if (val) handleWorSelect(val);
                      }}
                      className="bg-green-500 text-white px-5 py-2 rounded-lg font-bold hover:bg-green-600 shadow-md"
                    >
                      CHỌN
                    </button>
                  </div>
                </div>
              )}
              {showWords && playerDrawing && socket && playerDrawing.id !== socket.id && (
                <div className="text-xl font-bold text-slate-700 absolute h-full w-full top-0 left-0 flex justify-center items-center z-10 bg-white bg-opacity-90 rounded-lg animate-pulse">
                  {`${playerDrawing.name} đang chọn từ...`}
                </div>
              )}
            </div>
          </div>

          <div className="w-[300px] h-[540px] border border-black flex flex-col-reverse rounded-b-lg p-1">
            <form onSubmit={handleSubmitForm}>
              <input
                value={inputMessage}
                placeholder="Type your guess here"
                className={`min-w-full active max-w-full text-black flex flex-wrap px-6 py-2 rounded-lg font-medium bg-sky-50 border border-blue-300 text-md focus:outline-none ${
                  currentUserDrawing || showWords || !gameStarted ? "cursor-not-allowed" : ""
                }`}
                onChange={(e) => setInputMessage(e.target.value)}
                disabled={currentUserDrawing || showWords || !gameStarted || guessedWord}
              />
            </form>
            <div className="overflow-y-auto flex flex-col-reverse h-full">
              {allChats &&
                allChats.length > 0 &&
                allChats.map((chat, idx) => (
                  <p
                    className={`${chat.rightGuess ? "bg-green-200 text-green-600 font-bold" : ""}`}
                    key={idx}
                  >
                    {chat.rightGuess ? chat.message : `${chat.sender}: ${chat.message}`}
                  </p>
                ))}
            </div>
          </div>
        </div>

        {currentUserDrawing && (
          <div className="flex flex-col items-center gap-2 mt-2">
            <div className="flex justify-center gap-1">
              {basicColors.map((c, index) => (
                <button
                  key={index}
                  style={{ backgroundColor: c }}
                  onClick={() => setColor(c)}
                  className="w-10 h-10 border-2 border-slate-700 rounded-lg cursor-pointer shadow-sm hover:scale-105"
                />
              ))}
            </div>
            <div className="flex justify-center items-center gap-3">
              <button
                className="bg-black text-white px-4 py-2 rounded-lg font-bold"
                onClick={() => setIsEraser(!isEraser)}
              >
                {isEraser ? "Draw" : "Eraser"}
              </button>
              <button
                className="bg-black text-white px-4 py-2 rounded-lg font-bold"
                onClick={() => setStraightLineMode(!straightLineMode)}
              >
                {straightLineMode ? "Disable Line" : "Enable Line"}
              </button>
              <button
                className="bg-black text-white px-4 py-2 rounded-lg font-bold"
                onClick={fillCanvas}
              >
                Fill Canvas
              </button>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-10 h-10 cursor-pointer"
              />
              <label className="font-bold text-slate-800">Radius:</label>
              <input
                type="range"
                min="1"
                max="100"
                value={radius}
                onChange={(e) => setRadius(parseInt(e.target.value))}
              />
              <button
                className="bg-black text-white px-4 py-2 rounded-lg font-bold"
                onClick={clearCanvas}
              >
                Clear
              </button>
              <button
                className="bg-emerald-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-emerald-700 shadow-md"
                onClick={handleSaveDrawing}
              >
                Lưu tranh (Azure)
              </button>
            </div>
          </div>
        )}
      </div>

      {leaderboardData && (
        <div className="absolute top-0 left-0 w-full h-full bg-slate-900 bg-opacity-95 flex flex-col justify-center items-center text-white z-50 rounded-lg p-6">
          <h2 className="text-5xl font-extrabold mb-8 text-yellow-400 animate-bounce">
            🏆 KẾT QUẢ TRẬN ĐẤU 🏆
          </h2>

          <div className="w-full max-w-md bg-slate-800 rounded-xl p-6 shadow-2xl border-2 border-slate-600 max-h-[60%] overflow-y-auto">
            {leaderboardData.map((player, index) => {
              let medal = "🏅";
              if (index === 0) medal = "🥇";
              if (index === 1) medal = "🥈";
              if (index === 2) medal = "🥉";

              return (
                <div
                  key={index}
                  className="flex justify-between items-center p-4 mb-3 bg-slate-700 rounded-lg border border-slate-500"
                >
                  <div className="flex items-center gap-4">
                    <span className="text-3xl">{medal}</span>
                    <span className="font-bold text-xl">{player.name}</span>
                  </div>
                  <span className="font-extrabold text-2xl text-yellow-400">
                    {player.points} pts
                  </span>
                </div>
              );
            })}
          </div>

          {socket && socket.id === hostId ? (
            <button
              onClick={() => {
                setLeaderboardData(null);
                socket.emit("return-to-lobby");
              }}
              className="mt-8 px-8 py-3 bg-blue-500 hover:bg-blue-600 rounded-full font-bold text-white shadow-lg text-xl"
            >
              QUAY VỀ PHÒNG CHỜ
            </button>
          ) : (
            <p className="mt-8 text-sky-300 animate-pulse font-bold text-xl">
              Đang đợi Chủ phòng đưa về sảnh...
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default PlayScreen;