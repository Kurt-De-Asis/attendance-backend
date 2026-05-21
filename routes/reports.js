const express = require('express');
const ExcelJS = require('exceljs');

const { pool } = require('../database');
const { auth, roleAuth } = require('../middleware/auth');

const router = express.Router();
router.use(auth, roleAuth(['teacher', 'admin', 'student']));

// Get filtered attendance report (teacher/admin)
// Note: frontend uses GET for Search, and POST for CSV export.
const filteredSearchHandler = async (req, res) => {
  try {
    const { subjectId, gradeLevel, startDate, endDate, status } = req.query;
    let connection = await pool.getConnection();

    try {
    let query = `
      SELECT 
        s.name as subject,
        ses.session_date,
        ses.start_time,
        u.full_name,
        u.student_id,
        u.grade_level,
        a.start_scan_time,
        a.end_scan_time,
        CASE
          WHEN a.start_scan_time IS NOT NULL AND a.end_scan_time IS NULL THEN 'time_out_missing'
          WHEN a.start_scan_time IS NULL THEN 'time_in_missing'
          ELSE NULL
        END AS timeout_reason,
        COALESCE(a.end_scan_time, a.start_scan_time) as scan_time,
        CASE
          WHEN a.start_scan_time IS NULL THEN 'absent'
          ELSE a.status
        END AS status,

        a.session_id

      FROM sessions ses

       JOIN subjects s ON ses.subject_id = s.id
       JOIN enrollments e ON e.subject_id = s.id
       JOIN users u ON u.id = e.student_id
       LEFT JOIN attendance a ON a.session_id = ses.id AND a.student_id = u.id
       WHERE 1=1
    `;

    const params = [];

    // Filter by subject (for teacher, only their subjects)
    if (subjectId) {
      query += ' AND ses.subject_id = ?';
      params.push(subjectId);
    } else if (req.user.role === 'teacher') {
      query += ' AND s.teacher_id = ?';
      params.push(req.user.id);
    } else if (req.user.role === 'student') {
      query += ' AND u.id = ?';
      params.push(req.user.id);
    }

    // Filter by grade level
    if (gradeLevel) {
      query += ' AND u.grade_level = ?';
      params.push(gradeLevel);
    }

    // Filter by date range
    if (startDate) {
      query += ' AND ses.session_date >= ?';
      params.push(startDate);
    }
    if (endDate) {
      query += ' AND ses.session_date <= ?';
      params.push(endDate);
    }

    // Filter by status (must match the computed CASE used in SELECT)
    if (status) {
      const normalizedStatus = String(status).toLowerCase();
      query += ' AND (CASE ' +
        'WHEN a.start_scan_time IS NULL THEN "absent" ' +
        'ELSE a.status ' +
      'END) = ?';
      params.push(normalizedStatus);
    }

    query += ' ORDER BY ses.session_date DESC, a.start_scan_time DESC';

    const [attendance] = await connection.execute(query, params);

    if (req.query.format === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Attendance Report');

      worksheet.columns = [
        { header: 'Subject', key: 'subject', width: 28 },
        { header: 'Date', key: 'session_date', width: 14 },
        { header: 'Start Time', key: 'start_time', width: 14 },
        { header: 'Student Name', key: 'full_name', width: 25 },
        { header: 'Student ID', key: 'student_id', width: 16 },
        { header: 'Grade', key: 'grade_level', width: 12 },
        { header: 'Time In', key: 'start_scan_time', width: 14 },
        { header: 'Time Out', key: 'end_scan_time', width: 14 },
        { header: 'Scan Time', key: 'scan_time', width: 14 },
        { header: 'Timeout Reason', key: 'timeout_reason', width: 18 },
        { header: 'Status', key: 'status', width: 10 }
      ];

      const records = attendance.map(row => ({
        subject: row.subject,
        session_date: row.session_date,
        start_time: row.start_time,
        full_name: row.full_name,
        student_id: row.student_id,
        grade_level: row.grade_level,
        start_scan_time: row.start_scan_time,
        end_scan_time: row.end_scan_time,
        scan_time: row.scan_time,
        timeout_reason: row.timeout_reason,
        status: row.status
      }));

      records.forEach(r => worksheet.addRow(r));

      worksheet.getRow(1).font = { bold: true };

      const filename = `attendance_report_${new Date().toISOString().split('T')[0]}.xlsx`;
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

      const buffer = await workbook.xlsx.writeBuffer();
      res.send(buffer);
    } else if (req.query.format === 'csv') {
      // CSV response using ExcelJS for robustness
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Report');
      
      worksheet.columns = [
        { header: 'Subject', key: 'subject' },
        { header: 'Date', key: 'session_date' },
        { header: 'Start Time', key: 'start_time' },
        { header: 'Student Name', key: 'full_name' },
        { header: 'Student ID', key: 'student_id' },
        { header: 'Grade', key: 'grade_level' },
        { header: 'Time In', key: 'start_scan_time' },
        { header: 'Time Out', key: 'end_scan_time' },
        { header: 'Scan Time', key: 'scan_time' },
        { header: 'Timeout Reason', key: 'timeout_reason' },
        { header: 'Status', key: 'status' }
      ];

      const records = attendance.map(row => ({
        subject: row.subject,
        session_date: row.session_date,
        start_time: row.start_time,
        full_name: row.full_name,
        student_id: row.student_id,
        grade_level: row.grade_level,
        start_scan_time: row.start_scan_time,
        end_scan_time: row.end_scan_time,
        scan_time: row.scan_time,
        timeout_reason: row.timeout_reason,
        status: row.status
      }));

      records.forEach(r => worksheet.addRow(r));
      
      const filename = `attendance_report_${new Date().toISOString().split('T')[0]}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
      
      const buffer = await workbook.csv.writeBuffer();
      res.send(buffer);
    } else {
      res.json(attendance);
    }
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// GET filtered attendance report for teacher/admin
router.get('/filtered/search', filteredSearchHandler);

// POST filtered attendance report for teacher/admin (CSV export)
router.post('/filtered/search', filteredSearchHandler);



// Get attendance report for subject/session
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    let connection = await pool.getConnection();

    try {
    const [attendance] = await connection.execute(
      `SELECT 
        s.name as subject, 
        ses.session_date, 
        ses.start_time,
        u.full_name, 
        u.student_id, 
        u.grade_level,
        COALESCE(a.end_scan_time, a.start_scan_time) as scan_time,
        a.status


       FROM attendance a 
       JOIN users u ON a.student_id = u.id
       JOIN sessions ses ON a.session_id = ses.id
       JOIN subjects s ON ses.subject_id = s.id
       WHERE a.session_id = ?
       ORDER BY a.start_scan_time`,

      [sessionId]
    );

    if (req.query.format === 'csv') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Attendance');
      
      worksheet.columns = [
        { header: 'Subject', key: 'subject' },
        { header: 'Date', key: 'session_date' },
        { header: 'Start Time', key: 'start_time' },
        { header: 'Student Name', key: 'full_name' },
        { header: 'Student ID', key: 'student_id' },
        { header: 'Grade', key: 'grade_level' },
        { header: 'Scan Time', key: 'scan_time' },
        { header: 'Status', key: 'status' }
      ];
      
      const records = attendance.map(row => ({
        subject: row.subject,
        session_date: row.session_date,
        start_time: row.start_time,
        full_name: row.full_name,
        student_id: row.student_id,
        grade_level: row.grade_level,
        scan_time: row.scan_time,
        status: row.status
      }));

      records.forEach(r => worksheet.addRow(r));
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=attendance_${sessionId}.csv`);
      const buffer = await workbook.csv.writeBuffer();
      res.send(buffer);
    } else {
      res.json(attendance);
    }
    } finally {
      connection.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
