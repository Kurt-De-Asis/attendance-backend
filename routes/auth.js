const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const QRCode = require('qrcode');
const { pool } = require('../database'); // Import pool from database
const { auth, roleAuth } = require('../middleware/auth');

const router = express.Router();

// Helper to get pool from server context or use local
async function getConnection() {
  return await pool.getConnection();
}

// Register - Admin only
router.post('/register', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { student_id, email, role, full_name, grade_level, assigned_grade_levels } = req.body;

    if (!email || !role || !full_name) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let finalAssignedGradeLevels = [];
    if (role === 'teacher') {
      let rawLevels = [];
      // Initial normalization into an array
      if (Array.isArray(assigned_grade_levels)) {
        rawLevels = assigned_grade_levels;
      } else if (typeof assigned_grade_levels === 'string' && assigned_grade_levels.trim() !== '') {
        try {
          const parsed = JSON.parse(assigned_grade_levels);
          rawLevels = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
          if (assigned_grade_levels.includes(',')) {
            rawLevels = assigned_grade_levels.split(',').map(s => s.trim());
          } else {
            rawLevels = [assigned_grade_levels.trim()];
          }
        }
      }

      // Special handling for Chiplists: extract values if items are objects
      finalAssignedGradeLevels = rawLevels.map(item => {
        if (item && typeof item === 'object') {
          // Try common keys used in chip/select components (value, name, label, etc.)
          return item.value || item.name || item.label || item.id || item.grade_level || item.level || (item.toString() !== '[object Object]' ? item.toString() : null);
        }
        return item;
      }).filter(val => val !== undefined && val !== null && String(val).trim() !== '' && String(val) !== '[object Object]');

      // Validation is now optional to prevent blocking registration if the chiplist format is unexpected
      // The account will still be created even if grade levels fail to extract
      if (finalAssignedGradeLevels.some(level => typeof level !== 'string' && typeof level !== 'number')) {
        return res.status(400).json({ error: 'Assigned Year Levels must contain only strings or numbers.' });
      }
    }

    let connection = await getConnection();
    
    try {
    await connection.beginTransaction();

    // Check if user exists
    const [existing] = await connection.execute(
      'SELECT id, role, full_name FROM users WHERE email = ? OR student_id = ?',
      [email, student_id || '']
    );
    
    if (existing.length > 0) {
      await connection.rollback();
      const u = existing[0];
      return res.status(400).json({ error: `Account already exists for ${u.full_name} (Role: ${u.role}).` });
    }

    // Generate default password for student
    const defaultPassword = 'student123';
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(defaultPassword, salt);

    // Insert user
    const [result] = await connection.execute(
      'INSERT INTO users (student_id, email, password_hash, role, full_name, grade_level) VALUES (?, ?, ?, ?, ?, ?)',
      [student_id || null, email, password_hash, role, full_name, grade_level || null]
    );

    const newUserId = result.insertId;

    // If teacher, automatically assign the provided grade levels
    if (role === 'teacher') {
      for (const level of finalAssignedGradeLevels) {
        await connection.execute(
          'INSERT INTO teacher_grade_levels (teacher_id, grade_level) VALUES (?, ?)',
          [newUserId, level]
        );
      }
    }

    await connection.commit();

    // Generate JWT
    const token = jwt.sign(
      { id: newUserId, role, student_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: { id: newUserId, email, role, full_name, student_id }
    });
    } catch (dbErr) {
      await connection.rollback();
      throw dbErr;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    let connection = await getConnection();
    try {
    const [users] = await connection.execute(
      'SELECT * FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const user = users[0];
    const validPass = await bcrypt.compare(password, user.password_hash);
    
    if (!validPass) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, role: user.role, student_id: user.student_id },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, role: user.role, full_name: user.full_name, student_id: user.student_id }
    });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: list teachers
router.get('/teachers', auth, roleAuth(['admin']), async (req, res) => {
  try {
    let connection = await getConnection();
    try {
    const [teachers] = await connection.execute(
      'SELECT id, email, full_name, student_id FROM users WHERE role = ? ORDER BY full_name',
      ['teacher']
    );
    res.json(teachers);
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: edit teacher
router.put('/teachers/:id', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, full_name, password, assigned_grade_levels } = req.body;

    let connection = await getConnection();
    try {
    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE id = ? AND role = ?',
      [id, 'teacher']
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    await connection.beginTransaction();

    const updates = [];
    const values = [];

    if (email) {
      updates.push('email = ?');
      values.push(email);
    }
    if (full_name) {
      updates.push('full_name = ?');
      values.push(full_name);
    }
    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      updates.push('password_hash = ?');
      values.push(password_hash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No update values provided' });
    }

    values.push(id);
    await connection.execute(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ? AND role = 'teacher'`,
      values
    );

    // Update grade levels if provided in the edit
    if (assigned_grade_levels && Array.isArray(assigned_grade_levels)) {
      // 1. Remove old assignments
      await connection.execute('DELETE FROM teacher_grade_levels WHERE teacher_id = ?', [id]);
      
      // 2. Normalize and insert new ones (similar to register logic)
      const normalized = assigned_grade_levels.map(item => {
        if (item && typeof item === 'object') {
          return item.value || item.name || item.label || item.id || item.grade_level || item.level || String(item);
        }
        return item;
      }).filter(val => val !== undefined && val !== null && String(val).trim() !== '' && String(val) !== '[object Object]');

      for (const level of normalized) {
        try {
          await connection.execute(
            'INSERT INTO teacher_grade_levels (teacher_id, grade_level) VALUES (?, ?)',
            [id, level]
          );
        } catch (err) {
          if (err.code !== 'ER_DUP_ENTRY') throw err;
        }
      }
    }

    await connection.commit();
    res.json({ message: 'Teacher updated' });
    } catch (err) {
      if (connection) await connection.rollback();
      console.error(err);
      res.status(500).json({ error: 'Update failed' });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: delete teacher
router.delete('/teachers/:id', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    if (parseInt(id, 10) === req.user.id) {
      return res.status(400).json({ error: 'Admin cannot delete themselves' });
    }

    let connection = await getConnection();
    try {
    await connection.beginTransaction();

    // 1. Delete attendance for sessions related to this teacher's subjects or created by them
    await connection.execute(`
      DELETE FROM attendance 
      WHERE session_id IN (
        SELECT id FROM sessions 
        WHERE subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?) 
           OR created_by = ?
      )
    `, [id, id]);

    // 2. Delete sessions related to this teacher's subjects or created by them
    await connection.execute(`
      DELETE FROM sessions 
      WHERE subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?) 
         OR created_by = ?
    `, [id, id]);

    // 3. Delete enrollments for subjects taught by this teacher
    await connection.execute(`
      DELETE FROM enrollments 
      WHERE subject_id IN (SELECT id FROM subjects WHERE teacher_id = ?)
    `, [id]);

    // 4. Delete subjects taught by this teacher
    await connection.execute('DELETE FROM subjects WHERE teacher_id = ?', [id]);

    // 5. Finally delete the teacher user
    const [result] = await connection.execute(
      'DELETE FROM users WHERE id = ? AND role = ?',
      [id, 'teacher']
    );

    await connection.commit();

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Teacher not found or cannot be deleted' });
    }
    res.json({ message: 'Teacher deleted' });
    } catch (dbErr) {
      await connection.rollback();
      throw dbErr;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: list students
router.get('/students', auth, roleAuth(['admin']), async (req, res) => {
  try {
    let connection = await getConnection();
    try {
    const [students] = await connection.execute(
      'SELECT id, email, full_name, student_id, grade_level FROM users WHERE role = ? ORDER BY full_name',
      ['student']
    );
    res.json(students);
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: edit student
router.put('/students/:id', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { id } = req.params;
    const { email, full_name, student_id, grade_level, password } = req.body;

    let connection = await getConnection();
    try {
    const [existing] = await connection.execute(
      'SELECT id FROM users WHERE id = ? AND role = ?',
      [id, 'student']
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const updates = [];
    const values = [];

    if (email) {
      updates.push('email = ?');
      values.push(email);
    }
    if (full_name) {
      updates.push('full_name = ?');
      values.push(full_name);
    }
    if (student_id) {
      updates.push('student_id = ?');
      values.push(student_id);
    }
    if (grade_level) {
      updates.push('grade_level = ?');
      values.push(grade_level);
    }
    if (password) {
      const password_hash = await bcrypt.hash(password, 10);
      updates.push('password_hash = ?');
      values.push(password_hash);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No update values provided' });
    }

    values.push(id);
    await connection.execute(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ? AND role = 'student'`,
      values
    );

    res.json({ message: 'Student updated' });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: delete student
router.delete('/students/:id', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    let connection = await getConnection();
    try {
    await connection.beginTransaction();

    // 1. Delete student's attendance records
    await connection.execute('DELETE FROM attendance WHERE student_id = ?', [id]);

    // 2. Delete student's enrollments
    await connection.execute('DELETE FROM enrollments WHERE student_id = ?', [id]);

    // 3. Delete the student user
    const [result] = await connection.execute(
      'DELETE FROM users WHERE id = ? AND role = ?',
      [id, 'student']
    );

    await connection.commit();

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Student not found or cannot be deleted' });
    }
    res.json({ message: 'Student deleted' });
    } catch (dbErr) {
      await connection.rollback();
      throw dbErr;
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: register student + generate ONE single QR code for all subjects
router.post('/register-student-simple', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { first_name, last_name, subject_id, grade_level } = req.body;

    if (!first_name || !last_name || !subject_id || !grade_level) {
      return res.status(400).json({ error: 'Missing required fields: first_name, last_name, subject_id, grade_level' });
    }

    let connection = await getConnection();
    try {

    const timestamp = Date.now();
    const student_id = `S${timestamp}`;
    const email = `${student_id.toLowerCase()}@student.system`;
    const full_name = `${first_name} ${last_name}`;

    // Check if student_id or email already exists to clarify why registration might fail
    const [existingCheck] = await connection.execute(
      'SELECT id, role, full_name FROM users WHERE student_id = ? OR email = ?',
      [student_id, email]
    );
    if (existingCheck.length > 0) {
      const u = existingCheck[0];
      return res.status(400).json({ error: `An account already exists for ${u.full_name} (${u.role}).` });
    }

    // Verify subject exists
    const [subjectCheck] = await connection.execute(
      'SELECT id FROM subjects WHERE id = ?',
      [subject_id]
    );
    if (subjectCheck.length === 0) {
      return res.status(400).json({ error: 'Invalid subject/course selected' });
    }

    const defaultPassword = 'student123';
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(defaultPassword, salt);

    const studentQrCode = JSON.stringify({ studentId: student_id });

    await connection.beginTransaction();
    let userId;
    try {
      const [result] = await connection.execute(
        'INSERT INTO users (student_id, email, password_hash, role, full_name, grade_level, student_qr_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [student_id, email, password_hash, 'student', full_name, grade_level, studentQrCode]
      );
      userId = result.insertId;

      await connection.execute(
        'INSERT INTO enrollments (student_id, subject_id, qr_code_data) VALUES (?, ?, ?)',
        [userId, subject_id, studentQrCode]
      );
      await connection.commit();
    } catch (dbErr) {
      await connection.rollback();
      throw dbErr;
    }

    const qrImage = await QRCode.toDataURL(studentQrCode, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.status(201).json({
      message: 'Student registered with single QR code for all subjects',
      student: { id: userId, student_id, full_name, email, grade_level },
      qrData: studentQrCode,
      qrImage
    });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    // Ensure error responses don't leak logic, but also don't crash connection pool
    if (err.code === 'ER_DUP_ENTRY') {
      const sqlMsg = err.sqlMessage || '';
      let msg = 'Duplicate entry detected.';
      if (sqlMsg.includes('student_id')) msg = 'This Student ID is already registered.';
      else if (sqlMsg.includes('email')) msg = 'This Email is already in use by another account.';
      else if (sqlMsg.includes('student_qr_code')) msg = 'QR Code conflict: This ID is already assigned.';
      return res.status(400).json({ error: msg });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: get student profile with enrolled subjects
router.get('/students/:id/profile', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { id } = req.params;

    let connection = await getConnection();
    try {
    const [studentRows] = await connection.execute(
      'SELECT id, email, full_name, student_id, grade_level, role FROM users WHERE id = ? AND role = "student"',
      [id]
    );

    if (studentRows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const student = studentRows[0];

    const [subjects] = await connection.execute(
      `SELECT s.id, s.name, s.class_start_time, s.class_end_time
       FROM enrollments e
       JOIN subjects s ON s.id = e.subject_id
       WHERE e.student_id = ?
       ORDER BY s.name`,
      [student.id]
    );

    const [enrollmentSubjectIds] = await connection.execute(
      'SELECT subject_id FROM enrollments WHERE student_id = ? ORDER BY subject_id',
      [student.id]
    );

    res.json({
      student,
      enrolledSubjects: subjects,
      enrolledCount: subjects.length,
      debugEnrollmentSubjectIds: enrollmentSubjectIds.map(r => r.subject_id),
      rawEnrollmentCount: enrollmentSubjectIds.length
    });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: register student + enroll in multiple subjects
router.post('/register-student-multi-subject', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { first_name, last_name, subject_ids, grade_level, email, student_id } = req.body;

    if (!first_name || !last_name || !Array.isArray(subject_ids) || subject_ids.length === 0 || !grade_level) {
      return res.status(400).json({
        error: 'Missing required fields: first_name, last_name, subject_ids (array), grade_level',
      });
    }

    // Email behavior (align with UI request):
    // - If client doesn't provide email (or it's blank), derive it from student_id.
    // - If client provides email, use it as-is.
    // This keeps old behavior compatible while ensuring student_id-based matching.
    if (!student_id || !String(student_id).trim()) {
      return res.status(400).json({
        error: 'Missing required fields: student_id',
      });
    }

    const derivedEmail = (email && String(email).trim())
      ? String(email).trim()
      : `${String(student_id).toLowerCase()}@student.system`;

    let connection = await getConnection();
    try {

    // Check if email or student_id already exists to provide detailed error
    const [existingUsers] = await connection.execute(
      'SELECT email, student_id, role, full_name FROM users WHERE email = ? OR student_id = ?',
      [derivedEmail, student_id]
    );

    if (existingUsers.length > 0) {
      const existing = existingUsers[0];
      const isEmailConflict = existing.email === derivedEmail;
      return res.status(400).json({ error: `The ${isEmailConflict ? 'Email' : 'Student ID'} is already used by ${existing.full_name} (${existing.role}).` });
    }

    // Normalize + dedupe subject IDs early (prevents duplicate/mismatched numeric/string ids)
    const normalizedSubjectIds = Array.from(new Set(subject_ids.map((sid) => Number(sid)).filter((sid) => Number.isFinite(sid))));

    // Verify all subjects exist
    const [subjectRows] = await connection.execute(
      `SELECT id FROM subjects WHERE id IN (${normalizedSubjectIds.map(() => '?').join(',')})`,
      normalizedSubjectIds
    );

    if (subjectRows.length !== normalizedSubjectIds.length) {
      return res.status(400).json({ error: 'One or more invalid subject/course selected' });
    }

    const full_name = `${first_name} ${last_name}`;

    const defaultPassword = 'student123';
    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(defaultPassword, salt);

    // Sugestion: Move QR payload generation to a helper function
    const generateQrPayload = (sId) => JSON.stringify({ studentId: sId });
    const studentQrCode = generateQrPayload(student_id);

    await connection.beginTransaction();
    let userId;
    try {
      // Insert student
      const [result] = await connection.execute(
      'INSERT INTO users (student_id, email, password_hash, role, full_name, grade_level, student_qr_code) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [student_id, derivedEmail, password_hash, 'student', full_name, grade_level, studentQrCode]
    );

      userId = result.insertId;

    const enrollmentInsertResults = [];
      for (const sid of normalizedSubjectIds) {
        try {
          const [insRes] = await connection.execute(
            `INSERT INTO enrollments (student_id, subject_id, qr_code_data)
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE qr_code_data = VALUES(qr_code_data)`,
            [userId, sid, studentQrCode]
          );
          enrollmentInsertResults.push({ sid, affectedRows: insRes?.affectedRows ?? null, warning: null });
        } catch (insertErr) {
          enrollmentInsertResults.push({
            sid,
            affectedRows: null,
            warning: insertErr?.message || String(insertErr),
          });
          throw insertErr;
        }
      }
      await connection.commit();
    } catch (e) {
      await connection.rollback();
      // rethrow to be handled by outer catch
      throw e;
    }


    // Re-verify checks
    const [enrollmentCheck] = await connection.execute(
      'SELECT subject_id FROM enrollments WHERE student_id = ? ORDER BY subject_id',
      [userId]
    );

    const enrolledSubjectIds = enrollmentCheck.map((r) => Number(r.subject_id));
    const missing = normalizedSubjectIds.filter((sid) => !enrolledSubjectIds.includes(sid));

    if (missing.length > 0) {
      return res.status(400).json({
        error: 'Enrollment incomplete',
      });
    }

    const qrImage = await QRCode.toDataURL(studentQrCode, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      }
    });

    res.status(201).json({
      message: 'Student registered with ONE QR code for ALL selected subjects',
      student: { id: userId, student_id, full_name, email, grade_level },
      qrData: studentQrCode,
      qrImage,
      enrolled_subject_ids: normalizedSubjectIds
    });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    if (err.code === 'ER_DUP_ENTRY') {
      const sqlMsg = err.sqlMessage || '';
      let msg = 'Duplicate entry detected.';
      if (sqlMsg.includes('student_id')) msg = `Student ID '${student_id}' is already registered.`;
      else if (sqlMsg.includes('email')) msg = 'This Email is already in use by another account.';
      else if (sqlMsg.includes('student_qr_code')) msg = 'QR Code conflict: This ID is already assigned.';
      return res.status(400).json({ error: msg });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: change own password
router.put('/admin/me/password', auth, roleAuth(['admin']), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }

    let connection = await getConnection();
    try {
    const [rows] = await connection.execute(
      'SELECT id, password_hash FROM users WHERE id = ? AND role = "admin"',
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    const validPass = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!validPass) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(new_password, salt);
    await connection.execute(
      'UPDATE users SET password_hash = ? WHERE id = ? AND role = "admin"',
      [password_hash, req.user.id]
    );

    res.json({ message: 'Password updated successfully' });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Teacher: get own profile
router.get('/teachers/me', auth, roleAuth(['teacher']), async (req, res) => {
  try {
    let connection = await getConnection();
    try {
    const [rows] = await connection.execute(
      'SELECT id, email, full_name, student_id, role, grade_level FROM users WHERE id = ? AND role = "teacher"',
      [req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Teacher not found' });
    res.json(rows[0]);
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Teacher: change own password
router.put('/teachers/me/password', auth, roleAuth(['teacher']), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }

    let connection = await getConnection();
    try {
    const [rows] = await connection.execute(
      'SELECT id, password_hash FROM users WHERE id = ? AND role = "teacher"',
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Teacher not found' });
    }

    const validPass = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!validPass) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    await connection.execute(
      'UPDATE users SET password_hash = ? WHERE id = ? AND role = "teacher"',
      [password_hash, req.user.id]
    );

    res.json({ message: 'Password updated successfully' });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Student: get own profile
router.get('/students/me', auth, roleAuth(['student']), async (req, res) => {
  try {
    let connection = await getConnection();
    try {
    const [rows] = await connection.execute(
      'SELECT id, email, full_name, student_id, role, grade_level FROM users WHERE id = ? AND role = "student"',
      [req.user.id]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    res.json(rows[0]);
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Student: change own password
router.put('/students/me/password', auth, roleAuth(['student']), async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }

    let connection = await getConnection();
    try {
    const [rows] = await connection.execute(
      'SELECT id, password_hash FROM users WHERE id = ? AND role = "student"',
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }

    const validPass = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!validPass) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);
    await connection.execute(
      'UPDATE users SET password_hash = ? WHERE id = ? AND role = "student"',
      [password_hash, req.user.id]
    );

    res.json({ message: 'Password updated successfully' });
    } finally {
      connection.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
