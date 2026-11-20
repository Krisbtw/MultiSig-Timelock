FROZEN DESIGN (the contract must follow this exactly)

Name: MultiSigTimelockWallet

Constants and settings
- MAX_OWNERS = 10. GRACE_PERIOD = 7 days. MIN_DELAY = 10 seconds. MAX_DELAY = 30 days.
- owners (address[]), isOwner (mapping address => bool), threshold (uint256), delay (uint256), txCount (uint256).
- enum Status { None, Pending, Queued, Executed, Cancelled }. "Expired" is NOT stored; it is derived: status is Queued and block.timestamp > unlockTime + GRACE_PERIOD.
- struct Tx { address to; uint256 value; bytes data; string note; address proposer; uint256 unlockTime; Status status; }
- mapping(uint256 => Tx) transactions; mapping(uint256 => mapping(address => bool)) approved; mapping(uint256 => mapping(address => bool)) cancelVoted.
- Approval and cancel-vote counts are NOT stored. They are computed on demand by looping over the current owners array (max 10) and counting approved[id][owner] or cancelVoted[id][owner]. This automatically ignores removed owners. Provide internal _approvalCount(id) and _cancelCount(id) and public view versions.

Constructor(address[] owners_, uint256 threshold_, uint256 delay_)
- owners_ length between 3 and MAX_OWNERS; each owner non-zero and unique; 2 <= threshold_ <= owners_.length; MIN_DELAY <= delay_ <= MAX_DELAY. Otherwise revert with the matching custom error.

Functions
- receive() external payable: emit Deposited(sender, amount, balanceAfter).
- submit(address to, uint256 value, bytes data, string note) onlyOwner returns (uint256 id): require to != address(0); create Tx with status Pending; set approved[id][msg.sender] = true (proposer auto-approves); emit Submitted and Approved. If threshold is already met (only possible if threshold were 1, which is not allowed) do nothing special.
- approve(uint256 id) onlyOwner: tx must exist and be Pending or Queued; revert AlreadyApproved if already approved; set approved; emit Approved. If status is Pending and _approvalCount(id) >= threshold, set status Queued, unlockTime = block.timestamp + delay, emit Queued(id, unlockTime). If already Queued, just record the approval without changing unlockTime.
- revoke(uint256 id) onlyOwner: tx must be Pending or Queued; revert NotApproved if caller has not approved; clear the approval; emit Revoked. If status is Queued and _approvalCount(id) < threshold, set status Pending and unlockTime = 0 (timer cleared).
- sync(uint256 id): public helper; if Queued and _approvalCount(id) < threshold (can happen after an owner is removed or threshold raised), demote to Pending and clear unlockTime.
- execute(uint256 id) onlyOwner nonReentrant: status must be Queued (else NotQueued); require _approvalCount(id) >= threshold (else NotApproved); require block.timestamp >= unlockTime (else TooEarly); require block.timestamp <= unlockTime + GRACE_PERIOD (else Expired). Set status = Executed BEFORE the external call (checks-effects-interactions). Then (bool ok, ) = to.call{value: value}(data); if !ok revert ExecutionFailed (the revert rolls back the status change). Emit Executed. Require address(this).balance >= value.
- voteCancel(uint256 id) onlyOwner: status must be Pending or Queued (else InvalidStatus). If msg.sender is the proposer: cancel immediately. Otherwise record cancelVoted (revert if already voted) and cancel when _cancelCount(id) >= threshold. Cancelling sets status Cancelled, emits Cancelled.
- Governance functions, each restricted by modifier onlySelf (msg.sender == address(this)), so they can only run through an executed proposal whose "to" is the wallet itself: addOwner(address), removeOwner(address), changeThreshold(uint256), changeDelay(uint256). Validate all the same rules as the constructor (keep 2 <= threshold <= owners.length and owners.length >= 3 after removal; delay within bounds). removeOwner must delete the owner from the array (swap and pop) and from isOwner. Do NOT put nonReentrant on governance functions (they run inside execute, which is already guarded; adding it would deadlock). Emit OwnerAdded, OwnerRemoved, ThresholdChanged, DelayChanged.
- Views: getOwners(), getTransaction(id) returning all Tx fields plus approvalCount and cancelCount, getStatus(id) returning a uint8 where 5 means Expired (derived), timeLeft(id) (seconds until unlock, 0 if not queued or already unlocked), isExpired(id).
- Custom errors: NotOwner, NotSelf, TxNotFound, AlreadyApproved, NotApproved, NotQueued, TooEarly, Expired, InvalidThreshold, InvalidOwner, InvalidDelay, InvalidStatus, ExecutionFailed, InsufficientBalance, Reentrancy.
- Events: Deposited, Submitted, Approved, Revoked, Queued, Executed, Cancelled, OwnerAdded, OwnerRemoved, ThresholdChanged, DelayChanged. Index the transaction id and the actor address where useful.
- Known limitation to document (not fix): if a removed owner is later re-added, their old approval flags on old transactions count again.
