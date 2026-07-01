# Regenerates persona/index.ts from the markdown sources. Run after editing persona/*.md.
import json
const_md = open('persona/constitution.md').read()
ex_md = open('persona/exemplars.md').read()
ver = json.load(open('persona/version.json'))['version']
with open('persona/index.ts','w') as f:
    f.write('// AUTO-CONVERTED from constitution.md / exemplars.md — persona ships inside the bundle.\n')
    f.write('// Edit the .md files, then re-run scripts/embed-persona.py to regenerate.\n\n')
    f.write(f'export const PERSONA_VERSION = {json.dumps(ver)};\n\n')
    f.write(f'export const CONSTITUTION = {json.dumps(const_md)};\n\n')
    f.write(f'export const EXEMPLARS = {json.dumps(ex_md)};\n')
print('ok')
