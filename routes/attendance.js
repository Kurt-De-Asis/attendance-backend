const express = require('express');
const { pool } = require('../database');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Helper functions moved to top-level to be accessible everywhere
const toSeconds = (t) => {
  if (!t) return 0;
  const [h, m, s] = t.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};

const addMinutesToTimeString = (timeStr, minutes) => {
  const totalSeconds = toSeconds(timeStr) + minutes * 60;
  const clamped = ((totalSeconds % 86400) + 86400) % 86400;
  const hh = String(Math.floor(clamped / 3600)).padStart(2, '0');
  const mm = String(Math.floor((clamped % 3600) / 60)).padStart(2, '0');
  const ss = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

const subtractMinutesFromTimeString = (timeStr, minutes) => {
  const totalSeconds = toSeconds(timeStr) - minutes * 60;
  const clamped = ((totalSeconds % 86400) + 86400) % 86400;
  const hh = String(Math.floor(clamped / 3600)).padStart(2, '0');
  const mm = String(Math.floor((clamped % 3600) / 60)).padStart(2, '0');
  const ss = String(clamped % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
};

// Common Scan Logic
const handleScan = async (req, res) => {
  try {
    const { qrData } = req.body;
    if (!qrData) {
      return res.status(400).json({ error: 'QR data required' });
    }

    let parsedQR;
    try {
      parsedQR = JSON.parse(qrData);
    } catch (e) {
      return res.status(400).json({ error: 'Invalid QR data format' });
    }
    const studentIdStr = parsedQR.studentId;

    let connection = await pool.getConnection();

    try {
    // Find student
    const [students] = await connection.execute(
      'SELECT id, full_name, student_id, grade_level FROM users WHERE student_id = ? AND role = "student"',
      [studentIdStr]
    );

    if (students.length === 0) {
      return res.status(400).json({ error: 'Student not found' });
    }

    const student = students[0];

    // Get student's enrolled subjects with class times
    const [enrolledSubjects] = await connection.execute(
      `SELECT s.id, s.name, s.class_start_time, s.class_end_time 
       FROM subjects s JOIN enrollments e ON s.id = e.subject_id 
       WHERE e.student_id = ?`,
      [student.id]
    );

    // Current time (HH:MM:SS)
    const now = new Date();
    const currentTimeStr = now.toTimeString().slice(0, 8);
    
    // Important: Use local date instead of UTC to avoid "yesterday" mismatch at certain hours
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    // MySQL-compatible datetime string for TIMESTAMP columns (no 'T' / no 'Z')
    const mysqlDateTime = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    // Find matching subject
    // Primary: class window (start <= now <= end)
    // Fallback: if already has a start_scan_time but end_scan_time is missing, allow time-out scans even after class_end_time.

    let targetSubject = null;
    const EARLY_BIRD_WINDOW_MINUTES = 15;

    // Pick ONLY ONE subject deterministically.
    // If multiple subject windows match, choose the one with the latest start time (most specific).
    const matchingSubjects = enrolledSubjects.filter((subject) => {
      const earlyBirdThreshold = subtractMinutesFromTimeString(subject.class_start_time, EARLY_BIRD_WINDOW_MINUTES);
      return (
        subject.class_start_time &&
        subject.class_end_time &&
        (
          (currentTimeStr >= subject.class_start_time && currentTimeStr <= subject.class_end_time) || // Within class time
          (currentTimeStr >= earlyBirdThreshold && currentTimeStr < subject.class_start_time) // Or within early bird window
        )
      );
    });

    if (matchingSubjects.length > 0) {
      matchingSubjects.sort((a, b) => {
        // TIME strings sort lexicographically in MySQL format HH:MM:SS
        // so this is deterministic.
        if (a.class_start_time === b.class_start_time) return 0;
        return a.class_start_time < b.class_start_time ? 1 : -1; // latest start first
      });
      targetSubject = matchingSubjects[0];
    }


    if (!targetSubject) {
      // No class window match.
      // For time-out (end scan), we MUST only select a subject whose class window already ended.
      // This prevents “end scan required”/“timeout” appearing even before the schedule.

      const enrolledSubjectIds = enrolledSubjects.map(s => s.id);

      if (enrolledSubjectIds.length > 0) {
        const connection2 = connection;
        const [sessionsForStudent] = await connection2.execute(
          `SELECT id, subject_id
           FROM sessions
           WHERE session_date = ? AND status = 'active' AND subject_id IN (${enrolledSubjectIds.map(() => '?').join(',')})
           ORDER BY id DESC`,
          [today, ...enrolledSubjectIds]
        );

        // Find session that has start_scan_time but missing end_scan_time AND subject window already ended.
        for (const ses of sessionsForStudent) {
          const subj = enrolledSubjects.find(s => s.id === ses.subject_id);
          if (!subj) continue;
          if (!subj.class_end_time) continue;

          // only allow end rescan when current time is already after the subject end time
          if (!(currentTimeStr >= subj.class_end_time)) continue;

          const [rows] = await connection2.execute(
            'SELECT start_scan_time, end_scan_time FROM attendance WHERE session_id = ? AND student_id = ?',
            [ses.id, student.id]
          );
          const row = rows[0];
          
          // Identify the subject if the student has at least a Time-In record.
          // This allows the system to recognize the class even if they already Timed-Out,
          // providing a "Verified" message instead of "No active class found".
          if (row && row.start_scan_time) {
            targetSubject = subj;
            break;
          }
        }
      }

      if (!targetSubject) {
        return res.status(400).json({ 
          error: 'No active class found for this student at current time',
          currentTime: currentTimeStr,
          enrolled: enrolledSubjects
        });
      }
    }

    const subjectId = targetSubject.id;


    // Check enrollment (redundant but safe)
    const [enroll] = await connection.execute(
      'SELECT id FROM enrollments WHERE student_id = ? AND subject_id = ?',
      [student.id, subjectId]
    );

    if (enroll.length === 0) {
      return res.status(400).json({ error: 'Student not enrolled in detected subject' });
    }

    // Get or create session
    const [sessions] = await connection.execute(
      'SELECT * FROM sessions WHERE subject_id = ? AND session_date = ? AND status = "active" ORDER BY id DESC LIMIT 1',
      [subjectId, today]
    );

    let sessionId;
    if (sessions.length === 0) {
      // When scanning as admin, we still need the session to belong to the assigned teacher
      const [subjectOwner] = await connection.execute(
        'SELECT teacher_id FROM subjects WHERE id = ?',
        [subjectId]
      );

      if (subjectOwner.length === 0) {
        return res.status(400).json({ error: 'Invalid subject' });
      }

      const teacherId = subjectOwner[0].teacher_id;

      const [result] = await connection.execute(
        'INSERT INTO sessions (subject_id, session_date, status, created_by) VALUES (?, ?, "active", ?)',
        [subjectId, today, teacherId]
      );
      sessionId = result.insertId;
    } else {
      sessionId = sessions[0].id;
    }

    // Attendance timing rules:
    // - If now is before class_start_time: student is LATE (missed start) and start scan should be marked as late.
    // - If now is within start window: record start scan.
    // - If now is after class_end_time: end scan must be (re)scanned to finalize end time; otherwise indicate re-scan required.
    // Note: this system doesn't create 'absent' rows; only updates when student scans.

    const subjectStart = targetSubject.class_start_time; // TIME string (HH:MM:SS)
    const subjectEnd = targetSubject.class_end_time; // TIME string (HH:MM:SS)

    // Grace interval: students are marked ON_TIME as long as they scan within start + 15 minutes.
    // Example: start 01:00:00 -> allowed on_time until 01:15:00; after that -> LATE.
    const LATE_GRACE_MINUTES = 15;
    const ABSENT_THRESHOLD_MINUTES = 30;

    const lateThreshold = addMinutesToTimeString(subjectStart, LATE_GRACE_MINUTES);
    const absentThreshold = addMinutesToTimeString(subjectStart, ABSENT_THRESHOLD_MINUTES);

    const isBeforeStart = currentTimeStr < subjectStart; // before actual session start
    const isAfterEnd = currentTimeStr >= subjectEnd;
    const isWithinStartToEnd = currentTimeStr >= subjectStart && currentTimeStr <= subjectEnd;
    const isAfterLateThreshold = currentTimeStr > lateThreshold; // scanned after grace window
    const isAfterAbsentThreshold = currentTimeStr > absentThreshold; // scanned after 30 mins
    const isWithinGrace = currentTimeStr >= subjectStart && currentTimeStr <= lateThreshold;

    // Fetch existing attendance row (one per student per session)
    const [existingRows] = await connection.execute(
      'SELECT * FROM attendance WHERE session_id = ? AND student_id = ?',
      [sessionId, student.id]
    );

    const existing = existingRows[0] || null;

    // Prevent duplicate scans within a 3-second window
    if (existing) {
      const lastScanTimestamp = existing.end_scan_time || existing.start_scan_time;
      if (lastScanTimestamp) {
        const secondsSinceLastScan = (now.getTime() - new Date(lastScanTimestamp).getTime()) / 1000;
        // Change success to true so the UI doesn't show a red error for a very fast double scan
        if (secondsSinceLastScan >= 0 && secondsSinceLastScan < 2.0) {
          return res.json({
            success: true, 
            message: `✅ Verified: ${student.full_name} is already recorded.`,
            isDuplicate: true,
            status: existing.status,
            student: {
              id: student.id,
              student_id: student.student_id,
              full_name: student.full_name,
              yearLevel: student.grade_level || parsedQR.yearLevel,
            },
            subject: targetSubject,
            sessionId,
            timestamp: now.toISOString(),
            currentTime: currentTimeStr,
            attendance: {
              start_scan_time: existing.start_scan_time,
              start_status: existing.start_status,
              end_scan_time: existing.end_scan_time,
              end_status: existing.end_status,
            }
          });
        }
      }
    }

    // Determine which field to update
    // - If scanning within the class window (including start), treat it as start scan if start_scan_time is missing.
    // - If scanning after end, treat it as end scan if end_scan_time is missing.
    // - If scanning before start, treat it as late start attempt (still update start_status='late').

    let updated = false;
    let action = '';

    // Update start scan
    if (!existing || !existing.start_scan_time) {
      if (isBeforeStart || isWithinStartToEnd) {
        // Determine status based on grace window.
        // - Before actual start => late
        // - From start <= time <= start+15 => on_time
        // - After start+15 but still within class window => late
        // - After start+30 => absent
        const startStatus = (isBeforeStart || isWithinGrace) ? 'on_time' : (isAfterAbsentThreshold ? 'missing' : 'late');
        const finalStatus = 'absent'; // Must time-out to earn present/late

        if (!existing) {
          await connection.execute(
            `INSERT INTO attendance (session_id, student_id, start_scan_time, start_status, status)
             VALUES (?, ?, ?, ?, ?)`,
            [sessionId, student.id, mysqlDateTime, startStatus, finalStatus]
          );

        } else {
          await connection.execute(
            `UPDATE attendance
             SET start_scan_time = ?, start_status = ?, status = ?
             WHERE session_id = ? AND student_id = ?`,
            [mysqlDateTime, startStatus, finalStatus, sessionId, student.id]
          );

        }
        updated = true;
        action = 'start_scanned';
      }
    }

    // Update end scan (only after end time)
    // NOTE: We only care about time-out for the selected session.
    // If there is no start_scan_time for this session, we must ask for TIME IN.
    if (!updated && isAfterEnd && (!existing || !existing.end_scan_time)) {
      const endStatus = 'on_time';

      // Keep final status consistent with whether start was late
      const finalStatus = existing?.start_status === 'on_time' ? 'present' : (existing?.start_status === 'late' ? 'late' : 'absent');
      if (!existing || !existing.start_scan_time) {
        const startStatus = isAfterAbsentThreshold ? 'missing' : 'late';
        const finalStatus = 'absent'; // Must time-out to earn present/late
        if (!existing) {
          await connection.execute(
            `INSERT INTO attendance (session_id, student_id, start_scan_time, start_status, status)
             VALUES (?, ?, ?, ?, ?)`,
            [sessionId, student.id, mysqlDateTime, startStatus, finalStatus]
          );
        } else {
          await connection.execute(
            `UPDATE attendance
             SET start_scan_time = ?, start_status = ?, status = ?
             WHERE session_id = ? AND student_id = ?`,
            [mysqlDateTime, startStatus, finalStatus, sessionId, student.id]
          );
        }
        updated = true;
        action = 'start_scanned';
      } else {
        await connection.execute(
          `UPDATE attendance
           SET end_scan_time = ?, end_status = ?, status = ?
           WHERE session_id = ? AND student_id = ?`,
          [mysqlDateTime, endStatus, finalStatus, sessionId, student.id]
        );

        updated = true;
        action = 'end_scanned';
      }
    }


    // Time-out rescan: if already has end_scan_time recorded, allow setting a timeout timestamp separately (optional behavior)
    // Your current schema does not include a dedicated timeout column, so we keep existing data unchanged.


    // If after end and start was never scanned, still require rescan for end? Your requirement says: "when subject end time is done after the student start time the student must scan again their qr to end the time".
    // So: if after end and start_scan_time exists but end_scan_time missing => re-scan required.

    // Decide response
    let responseMessage = '';
    let computedStatus = existing?.status || 'present';
    let requiresEndRescan = false;

    // Used for QR payload fields in response
    const yearLevelFromQR = parsedQR.yearLevel;


    if (isAfterEnd) {
      // Use the 'updated' flag or check action to determine success
      // instead of just relying on the 'existing' object from the start of the function
      const hasStart = !!existing?.start_scan_time || action === 'start_scanned';
      const hasEnd = !!existing?.end_scan_time || action === 'end_scanned';

      if (action === 'end_scanned' || (hasEnd && !updated)) {
        responseMessage = `✅ SUCCESS: Time-Out recorded for ${student.full_name}`;
        if (action === 'end_scanned') {
          computedStatus = existing?.start_status === 'on_time' ? 'present' : (existing?.start_status === 'late' ? 'late' : 'absent');
        }
      } else if (hasEnd) {
        responseMessage = `✅ Attendance completed for ${student.full_name}`;
      } else if (hasStart) {
        requiresEndRescan = true;
        responseMessage = `⚠️ Late Check-In recorded for ${student.full_name}. Scan again to log Time-Out for ${targetSubject.name}.`;
      } else {
        requiresEndRescan = true;
        responseMessage = `⚠️ Late Check-In recorded for ${student.full_name}. Scan again to log Time-Out for ${targetSubject.name}.`;
        computedStatus = 'absent';
      }
    } else if (isBeforeStart) {
      if (updated && action === 'start_scanned') {
        responseMessage = `✅ SUCCESS: Early Check-In for ${student.full_name}`;
        computedStatus = 'absent';
      } else {
        responseMessage = `✅ Confirmed: ${student.full_name} is already Checked-In (Early).`;
      }
    } else if (isWithinStartToEnd) {
      if (updated && action === 'start_scanned') {
        responseMessage = `✅ SUCCESS: Time-In recorded for ${student.full_name}`;
        computedStatus = 'absent';
      } else {
        responseMessage = `✅ Confirmed: ${student.full_name} is already Checked-In.`;
      }
    }

    // If we updated something, refresh row for accurate status
    if (updated) {
      const [refreshedRows] = await connection.execute(
        'SELECT * FROM attendance WHERE session_id = ? AND student_id = ?',
        [sessionId, student.id]
      );
      const attendanceRow = refreshedRows[0];

      return res.json({
        success: true,
        message: responseMessage,
        action,
        requiresEndRescan,
        status: attendanceRow?.status || computedStatus,
        student: {
          id: student.id,
          student_id: student.student_id,
          full_name: student.full_name,
          yearLevel: student.grade_level || parsedQR.yearLevel,
        },
        subject: targetSubject,
        sessionId,
        timestamp: now.toISOString(),
        currentTime: currentTimeStr,
        attendance: {
          start_scan_time: attendanceRow?.start_scan_time,
          start_status: attendanceRow?.start_status,
          end_scan_time: attendanceRow?.end_scan_time,
          end_status: attendanceRow?.end_status,
        }
      });
    }

    // Not updated: we still return a meaningful message (late or end rescan required)
    return res.json({
      success: true,
      message: responseMessage,
      action,
      requiresEndRescan,
      status: computedStatus,
      student: {
        id: student.id,
        student_id: student.student_id,
        full_name: student.full_name,
        yearLevel: student.grade_level,
      },
      subject: targetSubject,
      sessionId,
      timestamp: now.toISOString(),
      currentTime: currentTimeStr,
      attendance: existing ? {
        start_scan_time: existing.start_scan_time,
        start_status: existing.start_status,
        end_scan_time: existing.end_scan_time,
        end_status: existing.end_status,
      } : null
    });
    } finally {
      connection.release();
    }

  } catch (err) {
    const msg = err?.message || 'Auto-scan failed';
    console.error('Scan error:', msg, err?.stack);
    res.status(500).json({ error: msg });
  }
};

// Enforced single-QR-per-student: subject is inferred automatically from class time + enrollments.
router.post('/scan', handleScan);

// Auto-detect current subject from QR scan based on class time + enrollments
router.post('/scan-auto', handleScan);

// Get attendance for session
router.get('/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;
    let connection = await pool.getConnection();

    try {
    const [attendance] = await connection.execute(
      `SELECT a.*, u.full_name, u.student_id 
       FROM attendance a 
       JOIN users u ON a.student_id = u.id 
       WHERE a.session_id = ?
       ORDER BY a.start_scan_time`,
      [sessionId]
    );
    res.json(attendance);
    } finally {
      connection.release();
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;