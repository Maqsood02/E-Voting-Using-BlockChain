const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = (process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/votify').trim();

// MongoDB Connection Logic (Serverless friendly)
let isConnected = false;
const connectDB = async () => {
  if (isConnected) return;
  try {
    await mongoose.connect(MONGODB_URI);
    isConnected = true;
    console.log('Connected to MongoDB successfully');
    await seedAdmin();
    await seedCandidates();
  } catch (err) {
    console.error('MongoDB connection error:', err);
    throw err;
  }
};

// Middleware to ensure DB connection
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    res.status(500).json({ error: 'Database connection failed', details: err.message });
  }
});

async function seedAdmin() {
  try {
    const adminExists = await User.findOne({ role: 'admin' });
    if (!adminExists) {
      const admin = new User({
        name: 'Administrator',
        email: 'admin@votify.com',
        password: 'admin123',
        role: 'admin'
      });
      await admin.save();
      console.log('✅ Default admin account created: admin@votify.com / admin123');
    }
  } catch (err) {
    console.warn('Admin seeding skipped or failed.');
  }
}

async function seedCandidates() {
  try {
    const count = await Candidate.countDocuments();
    if (count === 0) {
      const initialCandidates = [
        { candidateId: 1, name: "Narendra Singh", party: "Bharatiya Janata Party", symbol: "🪷", voteCount: 0 },
        { candidateId: 2, name: "Rahul Verma", party: "Indian National Congress", symbol: "✋", voteCount: 0 },
        { candidateId: 3, name: "Arvind Sharma", party: "Aam Aadmi Party", symbol: "🧹", voteCount: 0 }
      ];
      await Candidate.insertMany(initialCandidates);
      console.log('✅ Initial candidates seeded to MongoDB');
    }
  } catch (err) {
    console.warn('Candidates seeding failed:', err);
  }
}

// --- Schemas & Models ---
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ['voter', 'admin'], default: 'voter' },
  hasVoted: { type: Boolean, default: false },
  votedFor: { type: Number, default: null } // Candidate ID
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const candidateSchema = new mongoose.Schema({
  candidateId: { type: Number, required: true, unique: true },
  name: { type: String, required: true },
  party: { type: String, required: true },
  symbol: { type: String },
  voteCount: { type: Number, default: 0 }
}, { timestamps: true });

const Candidate = mongoose.model('Candidate', candidateSchema);

const settingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

const Setting = mongoose.model('Setting', settingSchema);


app.use(cors());
app.use(express.json());

// Load configuration from environment variables
const RPC_URL = process.env.RPC_URL || 'http://127.0.0.1:8545';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// ABI for interacting with the EVoting Smart Contract
const CONTRACT_ABI = [
  "function candidatesCount() public view returns (uint256)",
  "function votersCount() public view returns (uint256)",
  "function votingActive() public view returns (bool)",
  "function registerCandidate(string memory _name, string memory _party) public",
  "function registerVoter(address _voter) public",
  "function vote(uint256 _candidateId) public",
  "function getCandidate(uint256 _candidateId) public view returns (uint256 id, string memory name, string memory party, uint256 voteCount)",
  "function getAllCandidates() public view returns (tuple(uint256 id, string memory name, string memory party, uint256 voteCount)[])",
  "function voters(address) public view returns (bool isRegistered, bool hasVoted, uint256 votedCandidateId)"
];

let provider;
let wallet;
let contract;

// Initialize Blockchain connection
if (PRIVATE_KEY && CONTRACT_ADDRESS) {
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, wallet);
    console.log(`Connected to blockchain at ${RPC_URL}`);
    console.log(`Interacting with contract at ${CONTRACT_ADDRESS}`);
  } catch (error) {
    console.error('Blockchain initialization error:', error.message);
  }
} else {
  console.warn('Blockchain environment variables missing. Please set RPC_URL, PRIVATE_KEY, and CONTRACT_ADDRESS in your .env file.');
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    contractAddress: CONTRACT_ADDRESS || 'Not connected',
    rpcUrl: RPC_URL
  });
});

/**
 * @api {post} /api/register User Registration
 */
app.post('/api/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ error: 'User already exists' });

    const user = new User({ name, email, password, role: role || 'voter' });
    await user.save();
    res.json({ success: true, message: 'User registered successfully', user: { name, email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * @api {post} /api/login User Login
 */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email, password });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ success: true, user: { name: user.name, email: user.email, role: user.role } });
  } catch (error) {
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * @api {post} /api/change-password Admin Password Change
 */
app.post('/api/change-password', async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  try {
    const user = await User.findOne({ email, password: currentPassword });
    if (!user) return res.status(401).json({ error: 'Current password incorrect' });

    user.password = newPassword;
    await user.save();
    res.json({ success: true, message: 'Password updated' });
  } catch (error) {
    res.status(500).json({ error: 'Update failed' });
  }
});

/**
 * @api {get} /api/users Get All Users (Admin)
 */
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}, '-password');
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * @api {post} /api/register-voter Register Voter
 */
app.post('/api/register-voter', async (req, res) => {
  const { voterAddress, email } = req.body;
  
  try {
    // If blockchain is active, register there
    if (contract) {
      const tx = await contract.registerVoter(voterAddress);
      await tx.wait();
    }
    
    // If email provided, update MongoDB user
    if (email) {
      await User.findOneAndUpdate({ email: email.toLowerCase() }, { hasVoted: true });
    }

    res.json({ success: true, message: 'Voter registered.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @api {post} /api/register-candidate Register Candidate
 */
app.post('/api/register-candidate', async (req, res) => {
  const { name, party, symbol } = req.body;
  
  try {
    let candidateId = Date.now(); // Default ID for simulation
    
    if (contract) {
      const tx = await contract.registerCandidate(name, party);
      await tx.wait();
      const count = await contract.candidatesCount();
      candidateId = Number(count);
    }

    const candidate = new Candidate({ candidateId, name, party, symbol });
    await candidate.save();

    res.json({ success: true, message: 'Candidate added to MongoDB and Blockchain.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * @api {get} /api/candidates Fetch Candidates
 */
app.get('/api/candidates', async (req, res) => {
  try {
    let candidates = await Candidate.find().sort({ candidateId: 1 });
    
    // If MongoDB is empty but blockchain is active, try syncing
    if (candidates.length === 0 && contract) {
      const raw = await contract.getAllCandidates();
      candidates = raw.map(c => ({
        candidateId: Number(c.id),
        name: c.name,
        party: c.party,
        voteCount: Number(c.voteCount)
      }));
      // Bulk insert to MongoDB if needed
      if (candidates.length > 0) await Candidate.insertMany(candidates);
    }

    res.json({ success: true, candidates });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

/**
 * @api {get} /api/results Get Results
 */
app.get('/api/results', async (req, res) => {
  try {
    const candidates = await Candidate.find().sort({ voteCount: -1 });
    const votersCount = await User.countDocuments({ hasVoted: true });
    const candidatesCount = candidates.length;

    res.json({
      success: true,
      candidatesCount,
      votersCount,
      candidates
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch results' });
  }
});

/**
 * @api {get} /api/user-status Get User Voting Status
 */
app.get('/api/user-status', async (req, res) => {
  const { email } = req.query;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true, hasVoted: user.hasVoted, votedFor: user.votedFor });
  } catch (error) {
    res.status(500).json({ error: 'Failed to check status' });
  }
});

/**
 * @api {post} /api/vote Cast Vote
 */
app.post('/api/vote', async (req, res) => {
  const { email, candidateId } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || user.hasVoted) return res.status(400).json({ error: 'Already voted' });

    // Update candidate vote count
    await Candidate.findOneAndUpdate({ candidateId }, { $inc: { voteCount: 1 } });
    
    // Update user status
    user.hasVoted = true;
    user.votedFor = candidateId;
    await user.save();

    res.json({ success: true, message: 'Vote recorded in MongoDB' });
  } catch (error) {
    res.status(500).json({ error: 'Voting failed' });
  }
});

/**
 * @api {post} /api/reset-votes Reset All Election Data
 */
app.post('/api/reset-votes', async (req, res) => {
  try {
    // Reset all candidate vote counts to 0
    await Candidate.updateMany({}, { voteCount: 0 });
    
    // Reset all users' voting status
    await User.updateMany({}, { hasVoted: false, votedFor: null });

    res.json({ success: true, message: 'All votes reset and users cleared.' });
  } catch (error) {
    res.status(500).json({ error: 'Reset failed' });
  }
});

/**
 * @api {get} /api/settings Get Global Settings
 */
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await Setting.find();
    const settingsMap = {};
    settings.forEach(s => { settingsMap[s.key] = s.value; });
    res.json({ success: true, settings: settingsMap });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

/**
 * @api {post} /api/settings Update Global Settings
 */
app.post('/api/settings', async (req, res) => {
  const { key, value } = req.body;
  try {
    await Setting.findOneAndUpdate({ key }, { value }, { upsert: true });
    res.json({ success: true, message: 'Setting updated' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to update setting' });
  }
});


// Export the app for Vercel
module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running smoothly on port ${PORT}`);
  });
}
