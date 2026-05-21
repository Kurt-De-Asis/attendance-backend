const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

dotenv.config();

// MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'password',
  database: process.env.DB_NAME || 'attendance_system',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

// Ensure required tables exist (migrations)
async function initializeDatabase(connection) {
  try {
    console.log('📦 Ensuring database schema is up to date...');
    
    /**
     * MIGRATION: teacher_grade_levels
     * Idinagdag ito para sa pag-assign ng specific year levels sa mga teachers.
     * Ginagawa itong "IF NOT EXISTS" para hindi mag-error kung nandiyan na ang table.
     */
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS teacher_grade_levels (
        id INT PRIMARY KEY AUTO_INCREMENT,
        teacher_id INT NOT NULL,
        grade_level VARCHAR(20) NOT NULL,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_teacher_grade (teacher_id, grade_level)
      )
    `);
    console.log('✅ Database schema initialized');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    throw err;
  }
}

// Test DB connection and run initialization
async function testConnection() {
  let connection;
  try {
    connection = await pool.getConnection();
    console.log('🚀 MySQL connection established successfully');
    await initializeDatabase(connection);
  } catch (err) {
    console.error('❌ MySQL connection or initialization failed:', err.message);
  } finally {
    if (connection) connection.release();
  }
}

module.exports = { pool, testConnection };
