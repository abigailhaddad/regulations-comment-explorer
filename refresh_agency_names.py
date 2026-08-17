"""Refresh agency_names.json from regulations.gov /v4/agencies.

Run by hand when new agencies show up; the daily build reads the committed
snapshot so it needs no API key. Wants REGULATIONS_API_KEY in the environment
(free from https://open.gsa.gov/api/regulationsgov/).
"""

import json
import os
import urllib.request

req = urllib.request.Request(
    "https://api.regulations.gov/v4/agencies",
    headers={"X-Api-Key": os.environ["REGULATIONS_API_KEY"]},
)
data = json.load(urllib.request.urlopen(req))["data"]
names = {r["id"]: (r["attributes"].get("name") or "").strip() for r in data}
names = {k: v for k, v in sorted(names.items()) if v}

with open("agency_names.json", "w") as f:
    json.dump(names, f, indent=1, ensure_ascii=False, sort_keys=True)
print(f"{len(names)} agency names -> agency_names.json")
