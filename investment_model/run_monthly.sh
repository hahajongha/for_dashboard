#!/bin/sh
cd "$(dirname "$0")"
python3 portfolio_engine.py --update && echo "open output/taa_pm_dashboard_v1.0_latest.html"
