const express = require('express');
const cors = require('cors');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

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
 * @api {post} /api/register-voter Register Voter
 * Allows Admin to register a voter address via the backend.
 */
app.post('/api/register-voter', async (req, res) => {
  const { voterAddress } = req.body;
  if (!voterAddress) {
    return res.status(400).json({ error: 'Voter address is required' });
  }

  if (!contract) {
    return res.status(500).json({ error: 'Blockchain backend not initialized. Set env variables.' });
  }

  try {
    const tx = await contract.registerVoter(voterAddress);
    await tx.wait();
    res.json({ success: true, transactionHash: tx.hash, message: 'Voter successfully registered.' });
  } catch (error) {
    console.error('Error registering voter:', error);
    res.status(500).json({ error: error.reason || error.message || 'Failed to register voter' });
  }
});

/**
 * @api {post} /api/register-candidate Register Candidate
 * Allows Admin to add a candidate to the ballot.
 */
app.post('/api/register-candidate', async (req, res) => {
  const { name, party } = req.body;
  if (!name || !party) {
    return res.status(400).json({ error: 'Candidate name and party are required' });
  }

  if (!contract) {
    return res.status(500).json({ error: 'Blockchain backend not initialized. Set env variables.' });
  }

  try {
    const tx = await contract.registerCandidate(name, party);
    await tx.wait();
    res.json({ success: true, transactionHash: tx.hash, message: 'Candidate registered successfully.' });
  } catch (error) {
    console.error('Error registering candidate:', error);
    res.status(500).json({ error: error.reason || error.message || 'Failed to register candidate' });
  }
});

/**
 * @api {get} /api/candidates Fetch Candidates
 * Fetches all active candidates and their details.
 */
app.get('/api/candidates', async (req, res) => {
  if (!contract) {
    return res.status(500).json({ error: 'Blockchain backend not initialized' });
  }

  try {
    // Calling the smart contract function to fetch all candidates directly
    const rawCandidates = await contract.getAllCandidates();
    const formattedCandidates = rawCandidates.map(c => ({
      id: Number(c.id),
      name: c.name,
      party: c.party,
      voteCount: Number(c.voteCount)
    }));

    res.json({ success: true, candidates: formattedCandidates });
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: error.reason || error.message || 'Failed to fetch candidates' });
  }
});

/**
 * @api {get} /api/results Get Results
 * Aggregates candidate data and voting status for the frontend dashboard.
 */
app.get('/api/results', async (req, res) => {
  if (!contract) {
    return res.status(500).json({ error: 'Blockchain backend not initialized' });
  }

  try {
    const rawCandidates = await contract.getAllCandidates();
    const candidatesCount = Number(await contract.candidatesCount());
    const votersCount = Number(await contract.votersCount());
    const votingActive = await contract.votingActive();

    const candidates = rawCandidates.map(c => ({
      id: Number(c.id),
      name: c.name,
      party: c.party,
      voteCount: Number(c.voteCount)
    }));

    res.json({
      success: true,
      votingActive,
      candidatesCount,
      votersCount,
      candidates
    });
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: error.reason || error.message || 'Failed to fetch results' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running smoothly on port ${PORT}`);
});
