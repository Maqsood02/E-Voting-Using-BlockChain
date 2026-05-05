#!/usr/bin/env python3
"""
EVoting Data Analysis Script
Calculates voter turnouts, candidate percentages, and outputs formatted summaries for reporting.
"""

import sys
import json

def analyze_results(candidates_json):
    try:
        candidates = json.loads(candidates_json)
    except json.JSONDecodeError:
        print("Invalid JSON data provided.")
        sys.exit(1)

    total_votes = sum(c['voteCount'] for c in candidates)
    print("=" * 45)
    print(" ELECTION DATA ANALYSIS REPORT")
    print("=" * 45)
    print(f"Total Votes Cast Across Blockchain: {total_votes}")
    print("-" * 45)

    if total_votes == 0:
        print("No votes have been recorded yet.")
        return

    # Sort candidates by voteCount descending
    sorted_candidates = sorted(candidates, key=lambda x: x['voteCount'], reverse=True)

    for rank, c in enumerate(sorted_candidates, start=1):
        percentage = (c['voteCount'] / total_votes) * 100
        print(f"Rank {rank}: {c['name']} ({c['party']})")
        print(f"        Votes: {c['voteCount']}  |  Turnout share: {percentage:.2f}%")
        print("-" * 45)

    print(f"Winner (Current Trend): {sorted_candidates[0]['name']}")
    print("=" * 45)

if __name__ == '__main__':
    # Test Data for immediate evaluation
    sample_data = [
        {"id": 1, "name": "Alice Henderson", "party": "Digital Security Group", "voteCount": 14},
        {"id": 2, "name": "Robert Chen", "party": "Forward Thinking Coalition", "voteCount": 22},
        {"id": 3, "name": "Sarah Al-Fayez", "party": "Campus Synergy Union", "voteCount": 18}
    ]
    
    if len(sys.argv) > 1:
        analyze_results(sys.argv[1])
    else:
        print("No command line input found. Displaying analysis using sample data:")
        analyze_results(json.dumps(sample_data))
