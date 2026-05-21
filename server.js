const express = require('express');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const { pool, testConnection } = require('./database');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Requires first for middleware
const { auth, roleAuth } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const subjectsRouter = require('./routes/subjects');
const qrRouter = require('./routes/qr');
const attendanceRouter = require('./routes/attendance');
const reportsRouter = require('./routes/reports');

// Basic route
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Attendance Backend Running' });
});

// Routes
app.use('/api/auth', authRouter);
app.use('/api/subjects', auth, subjectsRouter);
app.use('/api/qr', auth, qrRouter);
app.use('/api/attendance', auth, attendanceRouter);
app.use('/api/reports', auth, reportsRouter);




// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback: send index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  testConnection();
});

