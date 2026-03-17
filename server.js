// server.js
require('dotenv').config();
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { Server } = require('socket.io');
const kathakaliRoutes = require('./routes/kathakaliRoutes');
const uploadDataRoutes = require('./routes/uploadDataRoutes');
const eventsRoutes = require('./routes/eventsRoutes');
const chatRoutes = require('./routes/chatRoutes');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const proficiencyRoutes = require('./routes/proficiencyRoutes');
const { verifyAdminToken } = require('./middleware/authMiddleware');
const { JWT_SECRET } = require('./middleware/authMiddleware');
const {
  ADMIN_NAMESPACE,
  setSocketServer,
} = require('./services/realtimeService');

const app = express();
const httpServer = http.createServer(app);
const port =
  process.env.NODE_ENV === 'test' ? 0 : Number(process.env.PORT || 3001); // Choose any available port

// Secure CORS configuration with whitelisted origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'https://kathakali.comp.nus.edu.sg',
  'http://localhost', // Add this line
];

const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    console.warn(`CORS blocked request from origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true, // Allow cookies if needed
  optionsSuccessStatus: 200, // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Add a simple route
app.get('/api', (req, res) => {
  res.send('Hello, this is your Express backend!');
});

app.use('/api/kathakali', kathakaliRoutes);

app.use('/api/kathakali', uploadDataRoutes);

app.use('/api/events', eventsRoutes);

app.use('/api/chat', chatRoutes);

// Authentication routes (public)
app.use('/api/auth', authRoutes);

// Proficiency tracking routes
app.use('/api/proficiency', proficiencyRoutes);

// Admin routes (protected) - renamed to obscure URL
app.use('/api/k-manage', verifyAdminToken, adminRoutes);

const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 60000,
});

setSocketServer(io);

const adminRealtime = io.of(ADMIN_NAMESPACE);

adminRealtime.use((socket, next) => {
  try {
    const authToken = socket.handshake?.auth?.token;
    const headerToken = socket.handshake?.headers?.authorization;
    const rawToken = authToken || headerToken || '';
    const token = String(rawToken).startsWith('Bearer ')
      ? String(rawToken).slice(7)
      : String(rawToken || '');

    if (!token) {
      return next(new Error('Unauthorized'));
    }

    const decoded = jwt.verify(token, JWT_SECRET);
    const role = String(decoded?.role || '').toLowerCase();
    if (!['admin', 'editor', 'viewer'].includes(role)) {
      return next(new Error('Forbidden'));
    }

    return next();
  } catch (error) {
    return next(new Error('Unauthorized'));
  }
});

adminRealtime.on('connection', (socket) => {
  socket.on('subscribe_file', (fileName) => {
    const room = String(fileName || '').trim();
    if (!room) return;
    socket.join(`file:${room}`);
  });

  socket.on('unsubscribe_file', (fileName) => {
    const room = String(fileName || '').trim();
    if (!room) return;
    socket.leave(`file:${room}`);
  });
});

// Start the server
const server = httpServer.listen(port, () => {
  const address = server.address();
  const boundPort =
    typeof address === 'object' && address ? address.port : port;
  console.log(`Server is running on port ${boundPort}`);
});

const handleShutdown = () => {
  console.log('Shutting down gracefully');
  io.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
};

// Listen for termination signals
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

module.exports = server;
