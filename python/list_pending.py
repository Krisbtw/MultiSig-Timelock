#!/usr/bin/env python3
"""
list_pending.py — Read-only Python script using web3.py (ties to Lab Experiment 7).
Reads SEPOLIA_RPC_URL from .env, loads frontend/abi.json and frontend/config.json,
and prints a formatted table of all transactions in MultiSigTimelockWallet.
No private keys are used.
"""

import json
import os
import sys
from pathlib import Path
from dotenv import load_dotenv
from tabulate import tabulate
from web3 import Web3

STATUS_MAP = {
    0: "None",
    1: "Pending",
    2: "Queued",
    3: "Executed",
    4: "Cancelled",
    5: "Expired",
}


def main():
    root_dir = Path(__file__).resolve().parent.parent
    load_dotenv(root_dir / ".env")

    rpc_url = os.getenv("SEPOLIA_RPC_URL") or "http://127.0.0.1:8545"
    config_path = root_dir / "frontend" / "config.json"
    abi_path = root_dir / "frontend" / "abi.json"

    if not config_path.exists() or not abi_path.exists():
        print("Error: frontend/config.json or frontend/abi.json not found. Run scripts/deploy.js first.")
        sys.exit(1)

    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)
    with open(abi_path, "r", encoding="utf-8") as f:
        abi = json.load(f)

    contract_address = os.getenv("CONTRACT_ADDRESS") or config.get("contractAddress")
    if not contract_address:
        print("Error: No contractAddress found in frontend/config.json or CONTRACT_ADDRESS env var.")
        sys.exit(1)

    w3 = Web3(Web3.HTTPProvider(rpc_url))
    if not w3.is_connected():
        print(f"Error: Could not connect to RPC endpoint at {rpc_url}")
        sys.exit(1)

    checksum_addr = Web3.to_checksum_address(contract_address)
    contract = w3.eth.contract(address=checksum_addr, abi=abi)

    threshold = contract.functions.threshold().call()
    delay = contract.functions.delay().call()
    owners = contract.functions.getOwners().call()
    tx_count = contract.functions.txCount().call()
    balance_wei = w3.eth.get_balance(checksum_addr)

    print("================================================================================")
    print(" MultiSigTimelockWallet — Read-Only Python Inspector (web3.py)")
    print("================================================================================")
    print(f" RPC Endpoint     : {rpc_url}")
    print(f" Contract Address : {checksum_addr}")
    print(f" Wallet Balance   : {w3.from_wei(balance_wei, 'ether')} ETH")
    print(f" Threshold        : {threshold} of {len(owners)} owners")
    print(f" Time-Lock Delay  : {delay} seconds")
    print(f" Total Proposals  : {tx_count}")
    print("================================================================================\n")

    if tx_count == 0:
        print("No transactions submitted yet.")
        return

    rows = []
    for tx_id in range(tx_count):
        tx = contract.functions.getTransaction(tx_id).call()
        # tx tuple: (to, value, data, note, proposer, unlockTime, status, approvals, cancelVotes)
        to_addr, value_wei, _data, note, _proposer, _unlock_time, _raw_status, approvals, cancel_votes = tx
        effective_status = contract.functions.getStatus(tx_id).call()
        seconds_left = contract.functions.timeLeft(tx_id).call()

        rows.append([
            tx_id,
            to_addr,
            f"{w3.from_wei(value_wei, 'ether')} ETH",
            f"{approvals}/{threshold} (cancel: {cancel_votes})",
            STATUS_MAP.get(effective_status, f"Unknown({effective_status})"),
            f"{seconds_left}s",
            note,
        ])

    headers = ["ID", "Recipient", "Amount", "Approvals", "Status", "Seconds to Unlock", "Note"]
    print(tabulate(rows, headers=headers, tablefmt="github"))


if __name__ == "__main__":
    main()
