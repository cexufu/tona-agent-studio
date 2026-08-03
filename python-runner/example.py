from pathlib import Path
import pandas as pd

inputs = list(Path("/job/input").glob("*"))
summary = pd.DataFrame({"input_file": [item.name for item in inputs]})
summary.to_csv("/job/output/input_summary.csv", index=False)
print(f"wrote {len(summary)} rows")