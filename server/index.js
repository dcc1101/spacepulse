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

// ================= AUTH ROUTES =================

app.post('/api/users/register', async (req, res) => {
  const { student_faculty_id, full_name, email, password, role } = req.body;
  if (!student_faculty_id || !full_name || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const { data: user, error } = await supabase
      .from('users')
      .insert({
        student_faculty_id,
        full_name,
        email,
        password: hashedPassword,
        role: role || 'student'
      })
      .select('user_id, student_faculty_id, full_name, email, role')
      .single();

    if (error) return res.status(500).json({ error: error.message });

    await logEvent(user.user_id, 'USER_REGISTERED', { email: user.email, role: user.role });

    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

  const token = jwt.sign(
    { user_id: user.user_id, role: user.role, email: user.email },
    JWT_SECRET,
    { expiresIn: '8h' }
  );

  await logEvent(user.user_id, 'USER_LOGIN', { email: user.email });

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

app.patch('/api/bookings/:id/check-in', async (req, res) => {
  const { id } = req.params;

  const { data: booking, error: fetchError } = await supabase
    .from('bookings')
    .select('*')
    .eq('booking_id', id)
    .single();

  if (fetchError || !booking) return res.status(404).json({ error: 'Booking not found' });
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

app.patch('/api/bookings/:id/cancel', async (req, res) => {
  const { id } = req.params;

  const { data: booking } = await supabase
    .from('bookings')
    .select('reserved_by, room_id')
    .eq('booking_id', id)
    .single();

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

app.get('/api/analytics/room-usage', async (req, res) => {
  const { data, error } = await supabase
    .from('bookings')
    .select('room_id, rooms(room_name, building, category)')
    .in('status', ['confirmed', 'checked_in']);

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

app.get('/api/logs', authenticateToken, async (req, res) => {
  const { data, error } = await supabase
    .from('event_logs')
    .select('log_id, action, details, created_at, users(full_name, email)')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Background Cleanup Worker: runs every 30 seconds
setInterval(async () => {
  const now = new Date();
  const nowIso = now.toISOString();

  // 1. Expire confirmed bookings whose 15-minute deadline elapsed
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
          console.log(`Auto-completed Booking #${b.booking_id} (End time: ${b.end_time} passed).`);
        }
      }
    }
  }
}, 30000);

const PORT = process.env.PORT || 5000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server & Socket.IO running on port ${PORT}`));