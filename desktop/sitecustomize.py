# sitecustomize.py - copied into .venv\Scripts\Lib\site-packages by desktop\bundle.ps1.
# Do not edit the installed copy; the next build overwrites it.
#
# Why this exists: an embedded Python that has a python3XX._pth file next to it does NOT
# put the running script's own directory on sys.path. Skill scripts that import a sibling
# module (humanize-academic: `import docx_ooxml`; ppt-master: `import console_encoding`)
# therefore work on a dev machine (normal venv) and fail on every installed copy with
# ModuleNotFoundError. This restores the standard CPython behaviour: when started as
# `python path/to/x.py`, prepend x.py's directory. For `python -c` / `python -m`,
# argv[0] is "-c" / "-m" (not a file) and nothing is changed.
import os
import sys

try:
    _argv0 = sys.argv[0] if sys.argv else ""
    if _argv0 and os.path.isfile(_argv0):
        _d = os.path.dirname(os.path.abspath(_argv0))
        if _d not in sys.path:
            sys.path.insert(0, _d)
except Exception:
    pass
