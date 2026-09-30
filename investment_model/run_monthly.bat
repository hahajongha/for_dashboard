@echo off
cd /d %~dp0
python portfolio_engine.py --update
start "" output\taa_pm_dashboard_v1.0_latest.html
pause
