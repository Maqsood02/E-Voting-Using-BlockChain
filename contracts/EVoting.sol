// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title EVoting
 * @dev A smart contract for decentralized e-voting. It handles candidate registration,
 * voter registration, voting, and real-time result tracking with immutability.
 */
contract EVoting {
    struct Candidate {
        uint256 id;
        string name;
        string party;
        uint256 voteCount;
    }

    struct Voter {
        bool isRegistered;
        bool hasVoted;
        uint256 votedCandidateId;
    }

    address public admin;
    bool public votingActive;
    
    mapping(uint256 => Candidate) public candidates;
    uint256 public candidatesCount;
    
    mapping(address => Voter) public voters;
    uint256 public votersCount;

    // Events for logging actions on the blockchain
    event VoterRegistered(address indexed voterAddress);
    event CandidateRegistered(uint256 indexed candidateId, string name, string party);
    event VoteCast(address indexed voter, uint256 indexed candidateId);
    event VotingStatusChanged(bool active);

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only admin can perform this action.");
        _;
    }

    modifier onlyDuringVoting() {
        require(votingActive, "Voting is not currently active.");
        _;
    }

    constructor() {
        admin = msg.sender;
        votingActive = true;
    }

    /**
     * @dev Register a new candidate. Only Admin can add candidates.
     * @param _name Name of the candidate
     * @param _party Political party or affiliation of the candidate
     */
    function registerCandidate(string memory _name, string memory _party) public onlyAdmin {
        candidatesCount++;
        candidates[candidatesCount] = Candidate(candidatesCount, _name, _party, 0);
        emit CandidateRegistered(candidatesCount, _name, _party);
    }

    /**
     * @dev Register a voter. Admin can authorize any address to vote, or voters can register.
     * @param _voter The address of the voter to register
     */
    function registerVoter(address _voter) public onlyAdmin {
        require(!voters[_voter].isRegistered, "Voter is already registered.");
        voters[_voter].isRegistered = true;
        votersCount++;
        emit VoterRegistered(_voter);
    }

    /**
     * @dev Vote for a registered candidate. Prevents double voting.
     * @param _candidateId ID of the candidate to vote for
     */
    function vote(uint256 _candidateId) public onlyDuringVoting {
        require(voters[msg.sender].isRegistered, "You are not a registered voter.");
        require(!voters[msg.sender].hasVoted, "You have already voted.");
        require(_candidateId > 0 && _candidateId <= candidatesCount, "Invalid candidate ID.");

        voters[msg.sender].hasVoted = true;
        voters[msg.sender].votedCandidateId = _candidateId;
        candidates[_candidateId].voteCount++;

        emit VoteCast(msg.sender, _candidateId);
    }

    /**
     * @dev Toggle the active state of voting. Only Admin can start/end voting.
     * @param _active True to start voting, False to stop voting
     */
    function setVotingStatus(bool _active) public onlyAdmin {
        votingActive = _active;
        emit VotingStatusChanged(_active);
    }

    /**
     * @dev Get candidate details by ID.
     */
    function getCandidate(uint256 _candidateId) public view returns (uint256 id, string memory name, string memory party, uint256 voteCount) {
        require(_candidateId > 0 && _candidateId <= candidatesCount, "Candidate does not exist.");
        Candidate memory c = candidates[_candidateId];
        return (c.id, c.name, c.party, c.voteCount);
    }

    /**
     * @dev Returns all candidates as an array. Useful for client-side fetching.
     */
    function getAllCandidates() public view returns (Candidate[] memory) {
        Candidate[] memory list = new Candidate[](candidatesCount);
        for (uint256 i = 1; i <= candidatesCount; i++) {
            list[i - 1] = candidates[i];
        }
        return list;
    }
}
