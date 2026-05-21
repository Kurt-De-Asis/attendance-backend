const express = require('express');
const QRCode = require('qrcode');
const mysql = require('mysql2/promise');
const { pool } = require('../database');
const { auth, roleAuth } = require('../middleware/auth');

const router = express.Router();

router.use(auth, roleAuth(['teacher', 'admin']));

// Get student's single QR code (from users table)
router.get('/student-qr/:studentId', async (req, res) => {
  try {
    const { studentId } = req.params;

    let connection = await pool.getConnection();

    try {
    // Get student's single QR code
    const [students] = await connection.execute(
      'SELECT student_id, full_name, grade_level FROM users WHERE id = ? AND role = "student"',
      [studentId]
    );

    if (students.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = students[0];

// Generate QR from student_id
    const studentQrCode = JSON.stringify({ 
      studentId: student.student_id, 
      studentName: student.full_name || '', 
      yearLevel: student.grade_level || '' 
    });
    const qrImage = await QRCode.toDataURL(studentQrCode, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.json({
      studentId: student.student_id,
      fullName: student.full_name,
      yearLevel: student.grade_level || '',
      qrData: studentQrCode,
      qrImage
    });
    } finally {
      connection.release();
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Generate QR for student (uses their single QR code - works for all subjects)
router.post('/generate', async (req, res) => {
  try {
    const { studentId } = req.body; // student user ID

    let connection = await pool.getConnection();

    try {
    // Get student's single QR code
    const [students] = await connection.execute(
      'SELECT student_id, full_name, grade_level FROM users WHERE id = ? AND role = "student"',
      [studentId]
    );

    if (students.length === 0) {
      return res.status(400).json({ error: 'Student not found' });
    }

    const student = students[0];

// Generate QR from student_id (single QR system)
    const studentQrCode = JSON.stringify({ 
      studentId: student.student_id, 
      studentName: student.full_name || '', 
      yearLevel: student.grade_level || '' 
    });
    const qrImage = await QRCode.toDataURL(studentQrCode, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.json({
      qrData: studentQrCode,
      qrImage,
      downloadUrl: qrImage
    });
    } finally {
      connection.release();
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// Enroll student in subject (uses their single QR code - no new QR needed)
router.post('/enroll', async (req, res) => {
  try {
    const { studentId, subjectId } = req.body;

    let connection = await pool.getConnection();

    try {
    // Check student exists
    const [students] = await connection.execute(
      'SELECT id, student_id, full_name, grade_level FROM users WHERE id = ? AND role = "student"',
      [studentId]
    );

    if (students.length === 0) {
      return res.status(400).json({ error: 'Student not found' });
    }

// Note: Single QR system - student_qr_code not in users table, generated from student_id

    // Check duplicate enrollment
    const [existing] = await connection.execute(
      'SELECT id FROM enrollments WHERE student_id = ? AND subject_id = ?',
      [studentId, subjectId]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: 'Already enrolled in this subject' });
    }

    // Enroll without QR code - uses student's single QR from users table
    await connection.execute(
'INSERT INTO enrollments (student_id, subject_id, qr_code_data) VALUES (?, ?, ?)',
[studentId, subjectId, JSON.stringify({ 
      studentId: students[0].student_id,
      studentName: students[0].full_name || '',
      yearLevel: students[0].grade_level || '' 
    })]
    );

    res.status(201).json({ 
      message: 'Student enrolled in subject (uses their single QR code for all subjects)'
    });
    } finally {
      connection.release();
    }

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
