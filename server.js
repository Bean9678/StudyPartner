const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static('.')); // Serve HTML files from root

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});
const server = http.createServer(app);

// 1. Enable CORS so BOTH Web and Mobile apps can connect to this deployed server!
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let waitingQueue = []; // Stores objects shaped like: { socket, filters }

io.on('connection', (socket) => {
    console.log(`[🟢 CONNECTED] Device connected: ${socket.id}`);

    // Device initiates a matching request
    socket.on('find_partner', (userFilters) => {
        console.log(`[🔍 SEARCH REQUEST] ${socket.id} sent filters:`, userFilters);

        // Clean out this socket from queue just in case they are spamming the button
        waitingQueue = waitingQueue.filter(user => user.socket.id !== socket.id);

        // 2. Matching Logic: Find exactly 1 person with same Grade and at least 1 overlapping Subject
        const partnerIdx = waitingQueue.findIndex(waitingUser => {
            if (waitingUser.socket.id === socket.id) return false; // Can't match with self

            // Enforce Class/Grade overlap
            const gradeMatch = waitingUser.filters.grade === userFilters.grade;

            // Enforce at least 1 common subject
            const sharedSubjects = (userFilters.subjects || []).filter(sub =>
                (waitingUser.filters.subjects || []).includes(sub)
            );

            return gradeMatch && sharedSubjects.length > 0;
        });

        if (partnerIdx !== -1) {
            // Partner found! Pull them from the queue
            const partner = waitingQueue.splice(partnerIdx, 1)[0].socket;
            const roomId = `room_${Date.now()}_${Math.random()}`;
            console.log(`[✅ MATCH MADE] Putting ${socket.id} & ${partner.id} into ${roomId}`);

            // 3. Real-time Communication: Subscribe BOTH devices to the identical encrypted Room!
            socket.join(roomId);
            partner.join(roomId);
            socket.roomId = roomId;
            partner.roomId = roomId;

            // Notify both devices independently that they are successfully matched
            io.to(roomId).emit('matched', { roomId, message: 'Partner found!' });
        } else {
            console.log(`[⏳ WAITING] No exact match for ${socket.id} yet. Added to waiting pool.`);
            // No strict match found yet, place the device into the active wait pool
            waitingQueue.push({ socket, filters: userFilters });
            socket.emit('waiting', { message: 'In Queue: Waiting for someone with identical filters...' });
        }
    });

    // Basic text real-time relaying
    socket.on('send_message', (text) => {
        if (socket.roomId) {
            console.log(`[💬 MESSAGE] ${socket.id} -> ${socket.roomId}: ${text}`);
            // Broadcast message specifically to the peer in the room
            socket.to(socket.roomId).emit('receive_message', text);
        }
    });

    // Crucial Disconnect Handle
    socket.on('disconnect', () => {
        console.log(`[🔴 DISCONNECTED] Device lost connection: ${socket.id}`);
        // Purge them from queue if their phone drops internet
        waitingQueue = waitingQueue.filter(user => user.socket.id !== socket.id);

        if (socket.roomId) {
            socket.to(socket.roomId).emit('partner_left');
            socket.leave(socket.roomId);
        }
    });
});

// Use Environment port assigned by your Hosting Provider (Render, Heroku, etc.)
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => {
    res.send('StudyPartner Server is running');
});
server.listen(PORT, () => {
    console.log(`[🚀 SERVER LIVE] Engine running on port ${PORT}`);
});
