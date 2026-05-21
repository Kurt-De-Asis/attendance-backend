const jwt = require('jsonwebtoken');

const auth = (req, res, next) => {
  // Preferred: Authorization: Bearer <token>
  const headerToken = req.header('Authorization')?.replace('Bearer ', '');

  // Fallbacks: support browser form POST downloads (where Authorization header can't be set)
  const bodyToken = req.body?.token;
  const queryToken = req.query?.token;

  const token = headerToken || bodyToken || queryToken;

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, role, student_id }
    next();
  } catch (err) {
    res.status(400).json({ error: 'Invalid token.' });
  }
};


const roleAuth = (roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied. Insufficient role.' });
    }
    next();
  };
};

module.exports = { auth, roleAuth };
