import React, { useState, useEffect, useMemo } from 'react';
import { io } from 'socket.io-client';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
const socket = io(API_URL);

export default function App() {
  const [activeTab, setActiveTab] = useState('rooms'); // 'rooms' | 'my-bookings' | 'analytics' | 'logs'
  const [rooms, setRooms] = useState([]);
  const [myBookings, setMyBookings] = useState([]);
  const [analytics, setAnalytics] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [token, setToken] = useState(localStorage.getItem('token') || '');

  // Room Filter State
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [minCapacityFilter, setMinCapacityFilter] = useState('');

  // Auth Form State
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [studentFacultyId, setStudentFacultyId] = useState('');

  // Status & Notifications
  const [recentEvent, setRecentEvent] = useState(null);

  // Booking Modal State
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [bookingDate, setBookingDate] = useState('2026-09-25');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('10:00');
  const [groupSize, setGroupSize] = useState(2);
  const [bookingMsg, setBookingMsg] = useState(null);

  const fetchRooms = () => {
    fetch(`${API_URL}/api/rooms`)
      .then((res) => res.json())
      .then((data) => setRooms(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Error fetching rooms:', err));
  };

  const fetchMyBookings = () => {
    if (!token) return;
    fetch(`${API_URL}/api/bookings/my-bookings`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => res.json())
      .then((data) => setMyBookings(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Error fetching bookings:', err));
  };

  const fetchAnalytics = () => {
    fetch(`${API_URL}/api/analytics/room-usage`)
      .then((res) => res.json())
      .then((data) => setAnalytics(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Error fetching analytics:', err));
  };

  const fetchAuditLogs = () => {
    if (!token) return;
    fetch(`${API_URL}/api/logs`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => res.json())
      .then((data) => setAuditLogs(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Error fetching logs:', err));
  };

  useEffect(() => {
    fetchRooms();
    fetchAnalytics();
    if (token) {
      fetchMyBookings();
      fetchAuditLogs();
    }

    socket.on('booking:created', (data) => {
      setRecentEvent(`New Booking Confirmed: Room #${data.room_id} (${data.start_time} - ${data.end_time})`);
      fetchMyBookings();
      fetchAnalytics();
      fetchAuditLogs();
    });

    socket.on('booking:checked_in', (data) => {
      setRecentEvent(`Check-in Confirmed: Booking #${data.booking_id}`);
      fetchMyBookings();
      fetchAnalytics();
      fetchAuditLogs();
    });

    socket.on('booking:cancelled', (data) => {
      setRecentEvent(`Booking Cancelled/Expired: Booking #${data.booking_id}`);
      fetchMyBookings();
      fetchAnalytics();
      fetchAuditLogs();
    });

    return () => {
      socket.off('booking:created');
      socket.off('booking:checked_in');
      socket.off('booking:cancelled');
    };
  }, [token]);

  // Derive unique categories from room dataset
  const categories = useMemo(() => {
    const list = rooms.map((r) => r.category).filter(Boolean);
    return ['All', ...Array.from(new Set(list))];
  }, [rooms]);

  // Filtered rooms
  const filteredRooms = useMemo(() => {
    return rooms.filter((room) => {
      const matchCategory = selectedCategory === 'All' || room.category === selectedCategory;
      const matchCapacity = minCapacityFilter ? room.max_capacity >= Number(minCapacityFilter) : true;
      return matchCategory && matchCapacity;
    });
  }, [rooms, selectedCategory, minCapacityFilter]);

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok && data.token) {
        setToken(data.token);
        localStorage.setItem('token', data.token);
        fetchRooms();
        fetchMyBookings();
        fetchAnalytics();
        fetchAuditLogs();
      } else {
        alert(data.error || 'Login failed');
      }
    } catch {
      alert('Could not reach backend server.');
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_URL}/api/users/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_faculty_id: studentFacultyId,
          full_name: fullName,
          email,
          password,
          role: 'student'
        })
      });
      const data = await res.json();
      if (res.ok) {
        alert('Registration complete. You may now sign in.');
        setIsRegistering(false);
      } else {
        alert(data.error || 'Registration failed');
      }
    } catch {
      alert('Could not reach backend server.');
    }
  };

  const handleCheckIn = async (bookingId) => {
    try {
      const res = await fetch(`${API_URL}/api/bookings/${bookingId}/check-in`, {
        method: 'PATCH'
      });
      const data = await res.json();
      if (!res.ok) alert(data.error || 'Failed to check in');
      fetchMyBookings();
      fetchAnalytics();
      fetchAuditLogs();
    } catch {
      alert('Network error while processing check-in.');
    }
  };

  const handleCancelBooking = async (bookingId) => {
    try {
      const res = await fetch(`${API_URL}/api/bookings/${bookingId}/cancel`, {
        method: 'PATCH'
      });
      const data = await res.json();
      if (!res.ok) alert(data.error || 'Failed to cancel');
      fetchMyBookings();
      fetchAnalytics();
      fetchAuditLogs();
    } catch {
      alert('Network error while processing cancellation.');
    }
  };

  const handleCreateBooking = async (e) => {
    e.preventDefault();
    setBookingMsg(null);

    try {
      const res = await fetch(`${API_URL}/api/bookings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          room_id: selectedRoom.room_id,
          booking_date: bookingDate,
          start_time: startTime,
          end_time: endTime,
          group_size: Number(groupSize)
        })
      });

      const data = await res.json();

      if (res.ok) {
        setBookingMsg({ type: 'success', text: `Booking #${data.booking_id} confirmed.` });
        fetchMyBookings();
        fetchAnalytics();
        fetchAuditLogs();
        setTimeout(() => {
          setSelectedRoom(null);
          setBookingMsg(null);
        }, 1500);
      } else {
        setBookingMsg({ type: 'error', text: data.error || 'Failed to book.' });
      }
    } catch {
      setBookingMsg({ type: 'error', text: 'Server error while submitting booking.' });
    }
  };

  return (
    <div className="min-h-screen bg-stone-100 text-stone-800 flex flex-col font-sans">
      <div className="h-1.5 bg-[#C41E3A] w-full" />

      <header className="bg-white border-b border-stone-200 py-4 px-8 shadow-sm">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="border-l-4 border-[#C41E3A] pl-3">
            <h1 className="text-2xl font-bold tracking-tight text-[#C41E3A]">MAPÚA</h1>
            <p className="text-xs uppercase tracking-widest text-stone-500 font-semibold">
              SpacePulse Room Reservation
            </p>
          </div>

          {token && (
            <div className="flex items-center gap-4">
              <nav className="flex space-x-1 border border-stone-200 rounded p-1 bg-stone-50">
                <button
                  onClick={() => setActiveTab('rooms')}
                  className={`px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded ${
                    activeTab === 'rooms' ? 'bg-[#C41E3A] text-white shadow-xs' : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  Facilities
                </button>
                <button
                  onClick={() => {
                    setActiveTab('my-bookings');
                    fetchMyBookings();
                  }}
                  className={`px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded ${
                    activeTab === 'my-bookings' ? 'bg-[#C41E3A] text-white shadow-xs' : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  My Reservations
                </button>
                <button
                  onClick={() => {
                    setActiveTab('analytics');
                    fetchAnalytics();
                  }}
                  className={`px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded ${
                    activeTab === 'analytics' ? 'bg-[#C41E3A] text-white shadow-xs' : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  Analytics
                </button>
                <button
                  onClick={() => {
                    setActiveTab('logs');
                    fetchAuditLogs();
                  }}
                  className={`px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded ${
                    activeTab === 'logs' ? 'bg-[#C41E3A] text-white shadow-xs' : 'text-stone-600 hover:text-stone-900'
                  }`}
                >
                  Audit Logs
                </button>
              </nav>

              <button
                onClick={() => {
                  setToken('');
                  localStorage.removeItem('token');
                }}
                className="bg-stone-100 hover:bg-stone-200 text-stone-700 px-4 py-1.5 rounded border border-stone-300 text-xs font-semibold uppercase tracking-wider transition"
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto p-6 md:p-8 space-y-6">
        {recentEvent && (
          <div className="bg-stone-800 border-l-4 border-[#F59E0B] text-stone-100 px-4 py-3 rounded shadow flex items-center justify-between text-sm">
            <span className="font-medium tracking-wide">{recentEvent}</span>
            <button
              onClick={() => setRecentEvent(null)}
              className="text-xs uppercase font-semibold text-stone-400 hover:text-white ml-4 tracking-wider"
            >
              Dismiss
            </button>
          </div>
        )}

        {!token ? (
          <div className="bg-white border border-stone-200 rounded-lg p-8 max-w-md mx-auto shadow-sm mt-10">
            <div className="border-b border-stone-200 pb-4 mb-6">
              <h2 className="text-xl font-bold text-stone-900">
                {isRegistering ? 'Account Registration' : 'Portal Authentication'}
              </h2>
              <p className="text-xs text-stone-500 mt-1">
                {isRegistering
                  ? 'Create your credentials to access study spaces'
                  : 'Sign in with your institutional credentials'}
              </p>
            </div>

            {isRegistering ? (
              <form onSubmit={handleRegister} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Student / Faculty ID
                  </label>
                  <input
                    type="text"
                    value={studentFacultyId}
                    onChange={(e) => setStudentFacultyId(e.target.value)}
                    placeholder="2026-100234"
                    className="w-full p-2.5 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Full Name
                  </label>
                  <input
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    placeholder="Juan Dela Cruz"
                    className="w-full p-2.5 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="student@school.edu"
                    className="w-full p-2.5 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full p-2.5 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-[#C41E3A] hover:bg-[#A01830] text-white py-2.5 rounded font-semibold text-sm transition uppercase tracking-wider shadow"
                >
                  Create Account
                </button>

                <p className="text-center text-xs text-stone-500 pt-2">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => setIsRegistering(false)}
                    className="text-[#C41E3A] font-semibold hover:underline"
                  >
                    Sign In
                  </button>
                </p>
              </form>
            ) : (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="student@school.edu"
                    className="w-full p-2.5 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full p-2.5 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <button
                  type="submit"
                  className="w-full bg-[#C41E3A] hover:bg-[#A01830] text-white py-2.5 rounded font-semibold text-sm transition uppercase tracking-wider shadow"
                >
                  Log In
                </button>

                <p className="text-center text-xs text-stone-500 pt-2">
                  Need an account?{' '}
                  <button
                    type="button"
                    onClick={() => setIsRegistering(true)}
                    className="text-[#C41E3A] font-semibold hover:underline"
                  >
                    Register here
                  </button>
                </p>
              </form>
            )}
          </div>
        ) : activeTab === 'rooms' ? (
          /* Facilities Tab with Filter Bar */
          <div className="space-y-5">
            <div className="flex flex-col md:flex-row md:items-end justify-between border-b border-stone-200 pb-3 gap-3">
              <div>
                <h2 className="text-xl font-bold text-stone-900">Campus Facilities & Study Spaces</h2>
                <p className="text-xs text-stone-500 mt-0.5">Filter and reserve active facilities across campus</p>
              </div>
              <button
                onClick={fetchRooms}
                className="text-xs font-semibold uppercase tracking-wider bg-white hover:bg-stone-50 px-3 py-1.5 rounded border border-stone-300 text-stone-700 shadow-sm transition self-start md:self-auto"
              >
                Refresh
              </button>
            </div>

            {/* Filter Bar Controls */}
            <div className="bg-white border border-stone-200 rounded-lg p-4 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-bold uppercase tracking-wider text-stone-500 mr-2">Category:</span>
                {categories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3 py-1 rounded text-xs font-semibold transition ${
                      selectedCategory === cat
                        ? 'bg-[#C41E3A] text-white shadow-xs'
                        : 'bg-stone-100 hover:bg-stone-200 text-stone-700'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs font-bold uppercase tracking-wider text-stone-500 whitespace-nowrap">
                  Min Capacity:
                </label>
                <input
                  type="number"
                  min="1"
                  placeholder="Any"
                  value={minCapacityFilter}
                  onChange={(e) => setMinCapacityFilter(e.target.value)}
                  className="w-20 p-1.5 rounded border border-stone-300 text-xs focus:outline-none focus:border-[#C41E3A]"
                />
              </div>
            </div>

            {/* Room Card Grid */}
            {filteredRooms.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-lg p-8 text-center text-sm text-stone-500">
                No rooms match the selected criteria.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {filteredRooms.map((room) => (
                  <div
                    key={room.room_id}
                    className="bg-white border border-stone-200 rounded-lg p-5 hover:border-stone-400 transition shadow-sm flex flex-col justify-between"
                  >
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-stone-100 text-[#C41E3A] border border-stone-200">
                          {room.category || 'General Space'}
                        </span>
                        <span className="text-xs text-stone-400 font-medium">Room #{room.room_id}</span>
                      </div>
                      <h3 className="text-lg font-bold text-stone-900">{room.room_name}</h3>
                      <p className="text-xs text-stone-600">
                        <strong className="text-stone-800">Location:</strong> {room.building}
                      </p>
                      <p className="text-xs text-stone-600">
                        <strong className="text-stone-800">Capacity:</strong> {room.min_capacity} - {room.max_capacity} persons
                      </p>
                    </div>

                    <button
                      onClick={() => {
                        setSelectedRoom(room);
                        setBookingMsg(null);
                      }}
                      className="w-full mt-4 bg-stone-800 hover:bg-[#C41E3A] text-white py-2 rounded text-xs font-semibold uppercase tracking-wider transition"
                    >
                      Reserve Room
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'my-bookings' ? (
          /* My Reservations Tab */
          <div className="space-y-4">
            <div className="flex justify-between items-end border-b border-stone-200 pb-3">
              <div>
                <h2 className="text-xl font-bold text-stone-900">My Reservations</h2>
                <p className="text-xs text-stone-500 mt-0.5">Manage upcoming bookings, perform check-ins, or cancel</p>
              </div>
              <button
                onClick={fetchMyBookings}
                className="text-xs font-semibold uppercase tracking-wider bg-white hover:bg-stone-50 px-3 py-1.5 rounded border border-stone-300 text-stone-700 shadow-sm transition"
              >
                Refresh
              </button>
            </div>

            {myBookings.length === 0 ? (
              <div className="bg-white border border-stone-200 rounded-lg p-8 text-center text-sm text-stone-500">
                You have no active or previous reservations logged.
              </div>
            ) : (
              <div className="space-y-3">
                {myBookings.map((b) => (
                  <div
                    key={b.booking_id}
                    className="bg-white border border-stone-200 rounded-lg p-5 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-4"
                  >
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-bold text-stone-900 text-base">
                          {b.rooms?.room_name || `Room #${b.room_id}`}
                        </span>
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
                            b.status === 'confirmed'
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : b.status === 'checked_in'
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-stone-100 text-stone-600 border-stone-200'
                          }`}
                        >
                          {b.status}
                        </span>
                      </div>
                      <p className="text-xs text-stone-600">
                        Date: {b.booking_date} | Time: {b.start_time} - {b.end_time} | Group Size: {b.group_size}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {b.status === 'confirmed' && (
                        <>
                          <button
                            onClick={() => handleCheckIn(b.booking_id)}
                            className="bg-stone-800 hover:bg-stone-900 text-white px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-wider transition"
                          >
                            Check In
                          </button>
                          <button
                            onClick={() => handleCancelBooking(b.booking_id)}
                            className="bg-stone-100 hover:bg-stone-200 text-[#C41E3A] border border-stone-300 px-3 py-1.5 rounded text-xs font-semibold uppercase tracking-wider transition"
                          >
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'analytics' ? (
          /* Analytics Tab */
          <div className="space-y-4">
            <div className="flex justify-between items-end border-b border-stone-200 pb-3">
              <div>
                <h2 className="text-xl font-bold text-stone-900">Room Utilization & Analytics</h2>
                <p className="text-xs text-stone-500 mt-0.5">Aggregated reservation metrics for campus study areas</p>
              </div>
              <button
                onClick={fetchAnalytics}
                className="text-xs font-semibold uppercase tracking-wider bg-white hover:bg-stone-50 px-3 py-1.5 rounded border border-stone-300 text-stone-700 shadow-sm transition"
              >
                Refresh
              </button>
            </div>

            <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-50 border-b border-stone-200 uppercase font-semibold text-stone-600 tracking-wider">
                  <tr>
                    <th className="p-3">Room Name</th>
                    <th className="p-3">Room ID</th>
                    <th className="p-3 text-right">Confirmed Bookings</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200">
                  {analytics.length === 0 ? (
                    <tr>
                      <td colSpan="3" className="p-4 text-center text-stone-500">
                        No reservation data available yet.
                      </td>
                    </tr>
                  ) : (
                    analytics.map((item) => (
                      <tr key={item.room_id} className="hover:bg-stone-50">
                        <td className="p-3 font-semibold text-stone-800">{item.room_name}</td>
                        <td className="p-3 text-stone-500">#{item.room_id}</td>
                        <td className="p-3 text-right font-bold text-[#C41E3A]">{item.count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* Audit Logs Tab */
          <div className="space-y-4">
            <div className="flex justify-between items-end border-b border-stone-200 pb-3">
              <div>
                <h2 className="text-xl font-bold text-stone-900">System Event Audit Trail</h2>
                <p className="text-xs text-stone-500 mt-0.5">Real-time log of security, reservation, and lifecycle events</p>
              </div>
              <button
                onClick={fetchAuditLogs}
                className="text-xs font-semibold uppercase tracking-wider bg-white hover:bg-stone-50 px-3 py-1.5 rounded border border-stone-300 text-stone-700 shadow-sm transition"
              >
                Refresh
              </button>
            </div>

            <div className="bg-white border border-stone-200 rounded-lg overflow-hidden shadow-xs">
              <table className="w-full text-left text-xs">
                <thead className="bg-stone-50 border-b border-stone-200 uppercase font-semibold text-stone-600 tracking-wider">
                  <tr>
                    <th className="p-3">Timestamp</th>
                    <th className="p-3">Action</th>
                    <th className="p-3">User</th>
                    <th className="p-3">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-200 font-mono text-[11px]">
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan="4" className="p-4 text-center text-stone-500 font-sans">
                        No events logged yet.
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.log_id} className="hover:bg-stone-50">
                        <td className="p-3 text-stone-500 whitespace-nowrap">
                          {new Date(log.created_at).toLocaleString()}
                        </td>
                        <td className="p-3">
                          <span className="font-bold text-stone-800 bg-stone-100 px-1.5 py-0.5 rounded border border-stone-200">
                            {log.action}
                          </span>
                        </td>
                        <td className="p-3 text-stone-600 font-sans">
                          {log.users ? `${log.users.full_name} (${log.users.email})` : 'System Worker'}
                        </td>
                        <td className="p-3 text-stone-500 truncate max-w-xs">
                          {JSON.stringify(log.details)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Reservation Modal */}
        {selectedRoom && (
          <div className="fixed inset-0 bg-stone-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50">
            <div className="bg-white border border-stone-200 rounded-lg shadow-xl w-full max-w-md p-6 space-y-4">
              <div className="flex justify-between items-center border-b border-stone-200 pb-3">
                <h3 className="font-bold text-base text-stone-900 uppercase tracking-wide">
                  Reserve: {selectedRoom.room_name}
                </h3>
                <button
                  onClick={() => setSelectedRoom(null)}
                  className="text-stone-400 hover:text-stone-700 text-sm font-semibold"
                >
                  Close
                </button>
              </div>

              {bookingMsg && (
                <div
                  className={`p-3 rounded text-xs font-medium border ${
                    bookingMsg.type === 'success'
                      ? 'bg-stone-50 border-stone-400 text-stone-900'
                      : 'bg-red-50 border-[#C41E3A] text-[#C41E3A]'
                  }`}
                >
                  {bookingMsg.text}
                </div>
              )}

              <form onSubmit={handleCreateBooking} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Date
                  </label>
                  <input
                    type="date"
                    value={bookingDate}
                    onChange={(e) => setBookingDate(e.target.value)}
                    className="w-full p-2 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                      Start Time
                    </label>
                    <input
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                      className="w-full p-2 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                      End Time
                    </label>
                    <input
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                      className="w-full p-2 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                      required
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-stone-600 uppercase tracking-wider mb-1">
                    Group Size (Max: {selectedRoom.max_capacity})
                  </label>
                  <input
                    type="number"
                    min="1"
                    max={selectedRoom.max_capacity}
                    value={groupSize}
                    onChange={(e) => setGroupSize(e.target.value)}
                    className="w-full p-2 rounded border border-stone-300 text-sm focus:outline-none focus:border-[#C41E3A]"
                    required
                  />
                </div>

                <div className="flex gap-2 pt-3 border-t border-stone-200 mt-4">
                  <button
                    type="button"
                    onClick={() => setSelectedRoom(null)}
                    className="w-1/2 py-2 rounded bg-stone-100 hover:bg-stone-200 text-stone-700 text-xs font-semibold uppercase tracking-wider transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="w-1/2 py-2 rounded bg-[#C41E3A] hover:bg-[#A01830] text-white text-xs font-semibold uppercase tracking-wider transition shadow"
                  >
                    Confirm
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}