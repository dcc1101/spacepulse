const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();
const supabase = require('./supabaseClient');

const app = express();
app.use(cors());
app.use(express.json());

// Set up HTTP and Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH']
  }
});

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

// Email helper (Brevo HTTP API). Sends over HTTPS, so Render's free tier does not block it.
// Throws on failure so the callers' try/catch actually catches it.
async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: { name: 'SpacePulse', email: process.env.BREVO_SENDER_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Brevo ${res.status}: ${body}`);
  }
}

// Helper: Audit Log Function
async function logEvent(userId, action, details = {}) {
  try {
    const { error } = await supabase.from('event_logs').insert({
      user_id: userId || null,
      action,
      details
    });
    if (error) {
      console.error('Audit Log Error:', error.message);
    }
  } catch (err) {
    console.error('Audit Log Exception:', err.message);
  }
}

// Middleware: Authenticate JWT Token
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// Middleware: Restrict to specific roles (e.g. admin, teacher)
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// ================= AUTH ROUTES =================

// Step 1: Register — creates unverified user, emails a 6-digit code
app.post('/api/users/register', async (req, res) => {
  const { student_faculty_id, full_name, email, password, role } = req.body;
  if (!student_faculty_id || !full_name || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        student_faculty_id,
        full_name,
        email,
        password: hashedPassword,
        role: role || 'student',
        is_verified: false,
        verification_code: verificationCode
      })
      .select('user_id, student_faculty_id, full_name, email, role')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Send verification email
    try {
      await sendEmail({
        to: email,
        subject: 'Verify your SpacePulse account',
        html: `<p>Hi ${full_name},</p>
               <p>Your verification code is:</p>
               <h2>${verificationCode}</h2>
               <p>Enter this code in the app to activate your account.</p>`
      });
    } catch (mailErr) {
      console.error('Email send error:', mailErr.message);
      // Account is still created; verification can be resent later if you add that endpoint
    }

    await logEvent(user.user_id, 'USER_REGISTERED', { email: user.email, role: user.role });

    res.status(201).json({ message: 'Registered. Check your email for a verification code.', user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Verify email with the code
app.post('/api/users/verify', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('user_id, verification_code, is_verified')
    .eq('email', email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  if (user.is_verified) return res.status(400).json({ error: 'Account already verified' });
  if (user.verification_code !== code) return res.status(400).json({ error: 'Invalid verification code' });

  const { error: updateError } = await supabase
    .from('users')
    .update({ is_verified: true, verification_code: null })
    .eq('user_id', user.user_id);

  if (updateError) return res.status(500).json({ error: updateError.message });

  await logEvent(user.user_id, 'USER_VERIFIED', { email });

  res.json({ message: 'Account verified successfully. You can now log in.' });
});

// Resend verification code (for users who missed/lost the original)
app.post('/api/users/resend-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('user_id, full_name, email, is_verified')
    .eq('email', email)
    .single();

  if (error || !user) return res.status(404).json({ error: 'User not found' });
  if (user.is_verified) return res.status(400).json({ error: 'Account already verified' });

  const newCode = Math.floor(100000 + Math.random() * 900000).toString();

  const { error: updateError } = await supabase
    .from('users')
    .update({ verification_code: newCode })
    .eq('user_id', user.user_id);

  if (updateError) return res.status(500).json({ error: updateError.message });

  try {
    await sendEmail({
      to: user.email,
      subject: 'Your new SpacePulse verification code',
      html: `<p>Hi ${user.full_name},</p>
             <p>Your new verification code is:</p>
             <h2>${newCode}</h2>
             <p>Enter this code in the app to activate your account.</p>`
    });
  } catch (mailErr) {
    console.error('Email send error:', mailErr.message);
    return res.status(500).json({ error: 'Failed to send email. Try again later.' });
  }

  res.json({ message: 'A new verification code has been sent to your email.' });
});

// Login — blocks unverified accounts, returns role so frontend can route correctly
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('email', email)
    .single();

  if (error || !user) return res.status(401).json({ error: 'Invalid email or password' });

  const validPassword = await bcrypt.compare(password, user.password);
  if (!validPassword) return res.status(401).json({ error: 'Invalid email or password' });

  if (!user.is_verified) {
    return res.status(403).json({ error: 'Account not verified. Please check your email for the verification code.' });
  }

  const token = jwt.sign(
    { user_id: user.user_id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  await logEvent(user.user_id, 'USER_LOGIN', { email: user.email });

  // role tells the frontend which dashboard to route to: 'student' | 'teacher' | 'admin'
  res.json({
    message: 'Login successful',
    token,
    user: {
      user_id: user.user_id,
      full_name: user.full_name,
      email: user.email,
      role: user.role
    }
  });
});

// ================= ROOM & BOOKING ROUTES =================

app.get('/api/rooms', async (req, res) => {
  const { data, error } = await supabase.from('rooms').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Room recommendation — pass desired category + group size, get best-fit rooms back.
// NEW: if date, start_time and end_time are also passed, rooms that already have an
// overlapping confirmed/checked_in booking at that time are left out.
app.get('/api/rooms/recommend', async (req, res) => {
  const { category, group_size, date, start_time, end_time } = req.query;
  const size = parseInt(group_size, 10);

  if (!category || !size) {
    return res.status(400).json({ error: 'category and group_size query params are required' });
  }

  const checkAvailability = Boolean(date && start_time && end_time);
  if (checkAvailability && start_time >= end_time) {
    return res.status(400).json({ error: 'End time must be after start time' });
  }

  // NEW: removes rooms that are already booked during the requested time
  async function filterAvailable(rooms) {
    if (!checkAvailability || rooms.length === 0) return rooms;

    const { data: busy, error: busyError } = await supabase
      .from('bookings')
      .select('room_id')
      .in('room_id', rooms.map((r) => r.room_id))
      .eq('booking_date', date)
      .in('status', ['confirmed', 'checked_in'])
      .lt('start_time', end_time)
      .gt('end_time', start_time);

    if (busyError) throw new Error(busyError.message);

    const busyIds = new Set(busy.map((b) => b.room_id));
    return rooms.filter((r) => !busyIds.has(r.room_id));
  }

  try {
    const { data, error } = await supabase
      .from('rooms')
      .select('*')
      .eq('category', category)
      .eq('is_active', true)
      .gte('max_capacity', size)
      .lte('min_capacity', size)
      .order('max_capacity', { ascending: true }); // smallest room that still fits first = best fit

    if (error) return res.status(500).json({ error: error.message });

    const exact = await filterAvailable(data);
    if (exact.length > 0) {
      return res.json({ exact_match: true, recommendations: exact });
    }

    // Fallback: relax the min_capacity constraint, just find rooms that fit the group size
    const { data: fallback, error: fallbackError } = await supabase
      .from('rooms')
      .select('*')
      .eq('category', category)
      .eq('is_active', true)
      .gte('max_capacity', size)
      .order('max_capacity', { ascending: true });

    if (fallbackError) return res.status(500).json({ error: fallbackError.message });

    const available = await filterAvailable(fallback);
    res.json({ exact_match: false, recommendations: available });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', authenticateToken, async (req, res) => {
  const { room_id, booking_date, start_time, end_time, group_size } = req.body;
  const reserved_by = req.user.user_id;

  if (!room_id || !booking_date || !start_time || !end_time) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const { data: conflicts, error: conflictError } = await supabase
    .from('bookings')
    .select('booking_id, start_time, end_time')
    .eq('room_id', room_id)
    .eq('booking_date', booking_date)
    .in('status', ['confirmed', 'checked_in'])
    .lt('start_time', end_time)
    .gt('end_time', start_time);

  if (conflictError) return res.status(500).json({ error: conflictError.message });
  if (conflicts.length > 0) {
    return res.status(409).json({ error: 'Time slot conflicts with an existing booking' });
  }

  const checkInDeadline = new Date(`${booking_date}T${start_time}`);
  checkInDeadline.setMinutes(checkInDeadline.getMinutes() + 15);

  const { data: booking, error: insertError } = await supabase
    .from('bookings')
    .insert({
      room_id,
      reserved_by,
      booking_date,
      start_time,
      end_time,
      group_size: group_size || 1,
      status: 'confirmed',
      check_in_deadline: checkInDeadline.toISOString()
    })
    .select()
    .single();

  if (insertError) return res.status(500).json({ error: insertError.message });

  await logEvent(reserved_by, 'BOOKING_CREATED', {
    booking_id: booking.booking_id,
    room_id,
    date: booking_date,
    start_time,
    end_time
  });

  io.emit('booking:created', booking);
  res.status(201).json(booking);
});

app.get('/api/bookings/my-bookings', authenticateToken, async (req, res) => {
  const user_id = req.user.user_id;

  const { data, error } = await supabase
    .from('bookings')
    .select('*, rooms(room_name, building, category)')
    .eq('reserved_by', user_id)
    .order('booking_date', { ascending: false })
    .order('start_time', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/bookings/:id/check-in', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const { data: booking, error: fetchError } = await supabase
    .from('bookings')
    .select('*')
    .eq('booking_id', id)
    .single();

  if (fetchError || !booking) return res.status(404).json({ error: 'Booking not found' });

  // NEW: only the owner (or an admin) can check in
  if (booking.reserved_by !== req.user.user_id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only check in to your own bookings' });
  }
  if (booking.status !== 'confirmed') {
    return res.status(400).json({ error: `Cannot check in. Current status: ${booking.status}` });
  }

  if (new Date() > new Date(booking.check_in_deadline)) {
    await supabase.from('bookings').update({ status: 'expired' }).eq('booking_id', id);
    await logEvent(booking.reserved_by, 'BOOKING_EXPIRED_ON_ATTEMPT', { booking_id: id });
    return res.status(400).json({ error: 'Check-in deadline has passed. Reservation marked as expired.' });
  }

  const { data: updated, error: updateError } = await supabase
    .from('bookings')
    .update({ status: 'checked_in' })
    .eq('booking_id', id)
    .select()
    .single();

  if (updateError) return res.status(500).json({ error: updateError.message });

  await logEvent(booking.reserved_by, 'BOOKING_CHECKED_IN', {
    booking_id: updated.booking_id,
    room_id: updated.room_id
  });

  io.emit('booking:checked_in', updated);
  res.json({ message: 'Checked in successfully', booking: updated });
});

app.patch('/api/bookings/:id/cancel', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const { data: booking } = await supabase
    .from('bookings')
    .select('reserved_by, room_id')
    .eq('booking_id', id)
    .single();

  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  // NEW: only the owner (or an admin) can cancel
  if (booking.reserved_by !== req.user.user_id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You can only cancel your own bookings' });
  }

  const { data: updated, error } = await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('booking_id', id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });

  if (booking) {
    await logEvent(booking.reserved_by, 'BOOKING_CANCELLED', {
      booking_id: id,
      room_id: booking.room_id
    });
  }

  io.emit('booking:cancelled', updated);
  res.json({ message: 'Booking cancelled', booking: updated });
});

// ================= ANALYTICS =================

app.get('/api/analytics/room-usage', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('room_id, rooms(room_name, building, category)')
    .in('status', ['confirmed', 'checked_in', 'completed']);

  if (error) return res.status(500).json({ error: error.message });

  const usageCounts = {};
  data.forEach((b) => {
    const key = b.room_id;
    if (!usageCounts[key]) {
      usageCounts[key] = { room_id: key, room_name: b.rooms?.room_name || `Room ${key}`, count: 0 };
    }
    usageCounts[key].count++;
  });

  res.json(Object.values(usageCounts).sort((a, b) => b.count - a.count));
});

// Weekly booking trends — for a line/bar graph of bookings per week
app.get('/api/analytics/weekly-bookings', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('booking_date, status')
    .in('status', ['confirmed', 'checked_in', 'completed']);

  if (error) return res.status(500).json({ error: error.message });

  // NEW: group by term-relative week ("Week 1" = the week starting on TERM_START_DATE).
  // Set TERM_START_DATE (YYYY-MM-DD, ideally a Monday) in the environment variables.
  const termStart = new Date(process.env.TERM_START_DATE || '2026-08-17');
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  const weekCounts = {};
  data.forEach((b) => {
    const days = Math.floor((new Date(b.booking_date) - termStart) / MS_PER_DAY);
    if (days < 0) return; // booking is before the term started, skip it
    const weekNumber = Math.floor(days / 7) + 1;
    weekCounts[weekNumber] = (weekCounts[weekNumber] || 0) + 1;
  });

  // Fill in weeks with zero bookings so the chart has no gaps
  const maxWeek = Math.max(0, ...Object.keys(weekCounts).map(Number));
  const result = [];
  for (let w = 1; w <= maxWeek; w++) {
    result.push({ week: `Week ${w}`, count: weekCounts[w] || 0 });
  }

  res.json(result);
});

// NEW: Peak hours — bookings per start hour (7AM to 9PM)
app.get('/api/analytics/peak-hours', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('start_time');

  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  data.forEach((b) => {
    const h = parseInt(b.start_time.split(':')[0], 10);
    counts[h] = (counts[h] || 0) + 1;
  });

  const result = [];
  for (let h = 7; h <= 21; h++) {
    const label = `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'AM' : 'PM'}`;
    result.push({ hour: label, bookings: counts[h] || 0 });
  }

  res.json(result);
});

// NEW: Status breakdown — for the donut chart
app.get('/api/analytics/status-breakdown', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('status');

  if (error) return res.status(500).json({ error: error.message });

  const counts = {};
  data.forEach((b) => {
    counts[b.status] = (counts[b.status] || 0) + 1;
  });

  res.json(Object.entries(counts).map(([name, value]) => ({ name, value })));
});

// Audit logs — admin/teacher only, hidden from students
app.get('/api/logs', authenticateToken, requireRole('admin', 'teacher'), async (req, res) => {
  const { data, error } = await supabase
    .from('event_logs')
    .select('log_id, action, details, created_at, users(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ================= BACKGROUND CLEANUP WORKER =================
// Runs every 30 seconds
setInterval(async () => {
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Expire confirmed bookings whose 15-minute check-in deadline elapsed
  const { data: expiredBookings, error: expireError } = await supabase
    .from('bookings')
    .update({ status: 'expired' })
    .eq('status', 'confirmed')
    .lt('check_in_deadline', nowIso)
    .select();

  if (!expireError && expiredBookings && expiredBookings.length > 0) {
    for (const b of expiredBookings) {
      await logEvent(b.reserved_by, 'BOOKING_AUTO_EXPIRED', {
        booking_id: b.booking_id,
        room_id: b.room_id
      });
      io.emit('booking:cancelled', b);
    }
    console.log(`Auto-expired ${expiredBookings.length} missed booking(s).`);
  }

  // 2. Complete checked_in bookings whose end_time has passed
  const { data: activeCheckedIn, error: activeError } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'checked_in');

  if (!activeError && activeCheckedIn && activeCheckedIn.length > 0) {
    for (const b of activeCheckedIn) {
      const endDateTime = new Date(`${b.booking_date}T${b.end_time}`);
      if (now >= endDateTime) {
        const { data: completedBooking } = await supabase
          .from('bookings')
          .update({ status: 'completed' })
          .eq('booking_id', b.booking_id)
          .select()
          .single();

        if (completedBooking) {
          await logEvent(b.reserved_by, 'BOOKING_COMPLETED', {
            booking_id: b.booking_id,
            room_id: b.room_id
          });
          io.emit('booking:completed', completedBooking);
          console.log(`Auto-completed Booking #${b.booking_id} (checked-in, end time passed).`);
        }
      }
    }
  }

  // 3. NEW: bookings that were CONFIRMED (never checked in) but whose end_time has
  //    already passed and the 15-min grace window hasn't caught them yet (e.g. a long
  //    booking where check-in happened late in the grace window then was never used).
  //    This is the fix for "my reservations" showing stale bookings — anything whose
  //    end_time has passed is no longer active, regardless of check-in status.
  const { data: staleConfirmed, error: staleError } = await supabase
    .from('bookings')
    .select('*')
    .eq('status', 'confirmed');

  if (!staleError && staleConfirmed && staleConfirmed.length > 0) {
    for (const b of staleConfirmed) {
      const endDateTime = new Date(`${b.booking_date}T${b.end_time}`);
      if (now >= endDateTime) {
        const { data: expired } = await supabase
          .from('bookings')
          .update({ status: 'expired' })
          .eq('booking_id', b.booking_id)
          .select()
          .single();

        if (expired) {
          await logEvent(b.reserved_by, 'BOOKING_AUTO_EXPIRED_NO_SHOW', {
            booking_id: b.booking_id,
            room_id: b.room_id
          });
          io.emit('booking:cancelled', expired);
        }
      }
    }
  }
}, 30000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server & Socket.IO running on port ${PORT}`));