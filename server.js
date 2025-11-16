// Wheel of Fortune multiplayer server placeholder
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
app.use(cors());

const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

io.on("connection", socket => {
  console.log("WOF connected:", socket.id);
  socket.emit("connected", { ok: true });
});

const port = process.env.PORT || 3000;
httpServer.listen(port, () => console.log("WOF server running on", port));
