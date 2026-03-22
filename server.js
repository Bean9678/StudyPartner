const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = 'supersecret_key_change_in_prod';

// In-memory array database
const users = []; // Array of { username, passwordHash }
let waitingQueue = []; // Array of socket objects
const rooms = new Map(); // roomId -> Set of sockets

// ---------------------------
// 2. BACKEND API ROUTES
// ---------------------------
app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
    
    // Check if user already exists
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }
    
    // Hash password using bcrypt
    const passwordHash = await bcrypt.hash(password, 10);
    users.push({ username, passwordHash });
    
    res.json({ message: 'Registration successful' });
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    // Find user
    const user = users.find(u => u.username === username);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    // Compare hashed password
    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) return res.status(400).json({ error: 'Invalid credentials' });

    // Generate JWT token
    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username });
});

// Serve frontend routing
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));


// ---------------------------
// 3. MATCHING & REALTIME SYSTEM
// ---------------------------
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error - missing token'));
    
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
        if (err) return next(new Error('Authentication error - invalid token'));
        socket.user = decoded; // attach user state
        next();
    });
});

const leaveRoom = (socket) => {
    if (socket.roomId) {
        socket.to(socket.roomId).emit('partner_left');
        socket.leave(socket.roomId);
        
        const room = rooms.get(socket.roomId);
        if (room) {
            room.delete(socket);
            if (room.size === 0) rooms.delete(socket.roomId);
        }
        socket.roomId = null;
    }
    socket.state = 'idle';
};

const findPartner = (socket) => {
    // Clean up any existing state
    waitingQueue = waitingQueue.filter(s => s !== socket);
    leaveRoom(socket);
    
    // Find partner who is waiting (exclude same user session)
    const partnerIdx = waitingQueue.findIndex(s => s.user.username !== socket.user.username);
    
    if (partnerIdx !== -1) {
        const partner = waitingQueue.splice(partnerIdx, 1)[0];
        const roomId = `room_${Date.now()}_${Math.random()}`;
        
        socket.roomId = roomId;
        partner.roomId = roomId;
        
        socket.join(roomId);
        partner.join(roomId);
        
        socket.state = 'matched';
        partner.state = 'matched';
        
        rooms.set(roomId, new Set([socket, partner]));
        
        io.to(roomId).emit('matched', { message: 'You have been matched! Say Hi.' });
    } else {
        waitingQueue.push(socket);
        socket.state = 'searching';
        socket.emit('waiting', { message: 'Waiting for a partner...' });
    }
};

io.on('connection', (socket) => {
    socket.state = 'idle'; // Initial state
    
    socket.on('find_partner', () => {
        findPartner(socket);
    });

    socket.on('send_message', (msg) => {
        if (socket.roomId && socket.state === 'matched') {
            // Emit to partner
            socket.to(socket.roomId).emit('receive_message', {
                sender: 'Partner',
                text: msg
            });
            // Emit to self
            socket.emit('receive_message', {
                sender: 'You',
                text: msg
            });
        }
    });

    socket.on('next', () => {
        findPartner(socket);
    });

    socket.on('disconnect', () => {
        waitingQueue = waitingQueue.filter(s => s !== socket);
        leaveRoom(socket);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
});
