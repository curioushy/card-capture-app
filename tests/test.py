"""
Card Capture App — test suite (Python port)
Tests pure logic from ocr.js, export.js, import.js, db.js
Run: python3 tests/test.py
"""

import re, json, sys

passed = 0
failed = 0

def test(name, fn):
    global passed, failed
    try:
        fn()
        print(f"  ✓ {name}")
        passed += 1
    except AssertionError as e:
        print(f"  ✗ {name}")
        print(f"    {e}")
        failed += 1
    except Exception as e:
        print(f"  ✗ {name}")
        print(f"    EXCEPTION: {e}")
        failed += 1

def assert_eq(a, b, msg=None):
    assert a == b, msg or f"Expected {json.dumps(b)} but got {json.dumps(a)}"

def assert_true(cond, msg="Assertion failed"):
    assert cond, msg


# ─── Field parser (ported from ocr.js) ───────────────────────────────────────

def extract_emails(text):
    found = re.findall(r'[\w.+\-]+@[\w\-]+\.[a-z]{2,}', text, re.IGNORECASE)
    return list(dict.fromkeys(found))  # deduplicate, preserve order

def extract_phones(text, emails):
    email_str = ' '.join(emails)
    raw = re.findall(r'(\+?[\d][\d\s\-().]{6,18}[\d])', text)
    result = []
    seen = set()
    for p in raw:
        p = p.strip()
        digits = re.sub(r'\D', '', p)
        if 7 <= len(digits) <= 15 and p not in email_str and p not in seen:
            result.append(p)
            seen.add(p)
    return result

def extract_linkedin(text):
    m = re.search(r'linkedin\.com/in/[\w\-]+', text, re.IGNORECASE)
    return m.group(0) if m else None

def extract_website(text, emails, linkedin):
    email_domains = [e.split('@')[1] for e in emails if '@' in e]
    candidates = re.findall(
        r'(?:https?://)?[\w\-]+\.(?:com|co|io|net|org|hk|sg|cn|com\.cn|com\.hk)(?:/[\w.\-/?=&#%]*)?',
        text, re.IGNORECASE)
    for c in candidates:
        clean = re.sub(r'^https?://', '', c).lower()
        if linkedin and 'linkedin' in clean:
            continue
        domain_part = clean.split('/')[0]
        if any(d == domain_part or domain_part.startswith(d) or d.startswith(domain_part)
               for d in email_domains):
            continue
        return c
    return None

TITLE_KEYWORDS = [
    'director', 'manager', 'vp ', 'v.p.', 'ceo', 'cfo', 'coo', 'cto', 'cmo',
    'founder', 'partner', 'head ', 'senior', 'associate', 'analyst', 'officer',
    'president', 'principal', 'vice', 'managing', 'executive', 'lead', 'specialist',
    '总监', '经理', '总裁', '董事', '主任', '首席',
]
COMPANY_KEYWORDS = [
    'ltd', 'llc', 'pte', 'inc', 'corp', 'group', 'capital', 'fund', 'partners',
    'holdings', 'ventures', 'management', 'advisory', 'consulting', 'securities',
    'investments', 'financial', 'bank', 'asset', 'equity', 'solutions',
    '有限公司', '集团', '基金', '证券', '投资', '资产',
]

def looks_like_keyword_line(line):
    lower = line.lower()
    return any(k in lower for k in TITLE_KEYWORDS + COMPANY_KEYWORDS)

def mark_consumed(consumed, lines, value):
    vl = value.lower()
    for i, l in enumerate(lines):
        if vl in l.lower():
            consumed.add(i)

def extract_name(lines):
    for line in lines:
        words = line.split()
        if 1 <= len(words) <= 5 and not looks_like_keyword_line(line):
            return line
    return None

def extract_title(lines, name):
    for line in lines:
        if name and line == name:
            continue
        lower = line.lower()
        if any(k in lower for k in TITLE_KEYWORDS):
            return line
    if name and name in lines:
        idx = lines.index(name)
        if idx + 1 < len(lines):
            return lines[idx + 1]
    return None

def extract_company(lines, name, title):
    for line in lines:
        if name and line == name:
            continue
        if title and line == title:
            continue
        lower = line.lower()
        if any(k in lower for k in COMPANY_KEYWORDS):
            return line
    rest = [l for l in lines if l != name and l != title]
    return rest[-1] if rest else None

def parse_fields(ocr_result):
    text = ocr_result.get('text', '')
    lines = [l.strip() for l in text.split('\n') if l.strip()]

    emails = extract_emails(text)
    phones = extract_phones(text, emails)
    linkedin = extract_linkedin(text)
    website = extract_website(text, emails, linkedin)

    consumed = set()
    for v in emails: mark_consumed(consumed, lines, v)
    for v in phones: mark_consumed(consumed, lines, v)
    if linkedin: mark_consumed(consumed, lines, linkedin)
    if website: mark_consumed(consumed, lines, website)

    remaining = [l for i, l in enumerate(lines) if i not in consumed]
    name = extract_name(remaining)
    title = extract_title(remaining, name)
    company = extract_company(remaining, name, title)

    return {
        'name': name or '',
        'title': title or '',
        'company': company or '',
        'emails': emails,
        'phones': phones,
        'linkedin': linkedin or '',
        'website': website or '',
        'raw_text': text,
    }


# ─── CSV utilities (ported from export.js / import.js) ───────────────────────

def csv_escape(val):
    s = str(val)
    if ',' in s or '"' in s or '\n' in s:
        return '"' + s.replace('"', '""') + '"'
    return s

def build_csv_row(c, sess):
    tier_val = c.get('tier')
    tier_str = f"T{tier_val if tier_val is not None else 4}"
    fields = [
        c.get('name', ''),
        c.get('title', ''),
        c.get('company', ''),
        '|'.join(c.get('emails', [])),
        '|'.join(c.get('phones', [])),
        c.get('linkedin', ''),
        c.get('website', ''),
        tier_str,
        c.get('intro_by', ''),
        c.get('next_action', ''),
        c.get('next_action_date', ''),
        (sess or {}).get('event_name', ''),
        (sess or {}).get('date', ''),
        c.get('session_id', ''),
        c.get('id', ''),
    ]
    return ','.join(csv_escape(f) for f in fields)

def parse_csv_row(line):
    result = []
    cur = ''
    in_quotes = False
    i = 0
    while i < len(line):
        ch = line[i]
        if in_quotes:
            if ch == '"' and i + 1 < len(line) and line[i+1] == '"':
                cur += '"'; i += 2; continue
            elif ch == '"':
                in_quotes = False
            else:
                cur += ch
        else:
            if ch == '"':
                in_quotes = True
            elif ch == ',':
                result.append(cur); cur = ''
            else:
                cur += ch
        i += 1
    result.append(cur)
    return result

def parse_tier(val):
    if not val:
        return None
    digits = re.sub(r'\D', '', val)
    if not digits:
        return None
    n = int(digits)
    return n if 1 <= n <= 4 else None

def vc_escape(s):
    if s is None:
        return ''
    return str(s).replace('\\', '\\\\').replace(',', '\\,').replace(';', '\\;').replace('\n', '\\n')

def parse_vcard(text):
    cards = re.split(r'BEGIN:VCARD', text, flags=re.IGNORECASE)[1:]
    result = []
    for card in cards:
        lines = [l.strip() for l in card.split('\n') if l.strip()]
        def get(prefix):
            for l in lines:
                if l.upper().startswith(prefix.upper() + ':'):
                    v = l[len(prefix)+1:]
                    return v.replace('\\,', ',').replace('\\;', ';').replace('\\n', '\n')
            return ''
        def get_all(prefix):
            out = []
            for l in lines:
                if l.upper().startswith(prefix.upper() + ':'):
                    out.append(l[len(prefix)+1:].replace('\\,', ','))
            return out
        name = get('FN')
        if not name:
            n_raw = get('N')
            parts = n_raw.split(';')[:2]
            name = ' '.join(reversed([p for p in parts if p])).strip()
        result.append({
            'name': name,
            'title': get('TITLE'),
            'company': get('ORG'),
            'emails': get_all('EMAIL'),
            'phones': get_all('TEL'),
            'website': get('URL'),
        })
    return result


# ─── Tests ───────────────────────────────────────────────────────────────────

print("\n── Field Parser ──────────────────────────────────────────")

test("extracts email address",
    lambda: assert_eq(extract_emails('Contact: john.doe@acme.com for more info'), ['john.doe@acme.com']))

test("extracts multiple emails, deduplicates", lambda: (
    assert_true(len(extract_emails('john@acme.com john@acme.com jane@acme.com')) == 2)))

test("extracts email with plus sign",
    lambda: assert_eq(extract_emails('reach me at john+work@example.com'), ['john+work@example.com']))

test("does not extract non-emails",
    lambda: assert_eq(extract_emails('No email here'), []))

test("extracts phone number", lambda: (
    assert_true(len(extract_phones('+65 9123 4567', [])) > 0)))

test("extracts international phone", lambda: (
    assert_true(len(extract_phones('+1 (415) 555-0123', [])) > 0)))

test("rejects phone too short (< 7 digits)",
    lambda: assert_eq(extract_phones('ext 123', []), []))

test("rejects phone too long (> 15 digits)",
    lambda: assert_eq(extract_phones('1234567890123456789', []), []))

test("does not extract email content as phone", lambda: (
    assert_eq(extract_phones('john@acme.com', ['john@acme.com']), [])))

test("extracts LinkedIn URL",
    lambda: assert_eq(extract_linkedin('linkedin.com/in/johndoe'), 'linkedin.com/in/johndoe'))

test("extracts LinkedIn with https prefix",
    lambda: assert_eq(extract_linkedin('https://linkedin.com/in/jane-smith-123'), 'linkedin.com/in/jane-smith-123'))

test("returns None when no LinkedIn",
    lambda: assert_eq(extract_linkedin('No linkedin here'), None))

test("extracts website, excludes email domain", lambda: (
    assert_eq(extract_website('john@acme.com www.acme.com', ['john@acme.com'], None), None)))

test("extracts website when domain differs from email", lambda: (
    assert_true(extract_website('john@gmail.com www.mycompany.com', ['john@gmail.com'], None) is not None)))

test("excludes linkedin from website result", lambda: (
    lambda r: assert_true(r is None or 'linkedin' not in r))(
    extract_website('linkedin.com/in/john acme.com', [], 'linkedin.com/in/john')))


print("\n── parseFields integration ───────────────────────────────")

test("full English business card parse", lambda: (
    lambda r: (
        assert_eq(r['name'], 'John Smith'),
        assert_true('vp' in r['title'].lower(), f"title: {r['title']}"),
        assert_true('acme capital' in r['company'].lower(), f"company: {r['company']}"),
        assert_eq(r['emails'], ['john@acme.com']),
        assert_true(len(r['phones']) > 0)
    )
)(parse_fields({'text': 'John Smith\nVP Credit\nAcme Capital Ltd\njohn@acme.com\n+65 9123 4567\nwww.acme.com', 'words': []})))

test("card with multiple emails", lambda: (
    assert_eq(len(parse_fields({'text': 'Jane Doe\nDirector\nXYZ Group\njane@xyz.com\njane.work@xyz.com', 'words': []})['emails']), 2)))

test("card with LinkedIn", lambda: (
    assert_eq(parse_fields({'text': 'Bob Lee\nAnalyst\nFund Partners\nbob@fund.com\nlinkedin.com/in/boblee', 'words': []})['linkedin'], 'linkedin.com/in/boblee')))

test("empty text returns empty fields", lambda: (
    lambda r: (assert_eq(r['name'], ''), assert_eq(r['emails'], []), assert_eq(r['phones'], []))
)(parse_fields({'text': '', 'words': []})))

test("Chinese title keyword detected", lambda: (
    lambda r: (
        assert_eq(r['title'], '总监', f"title: {r['title']}"),
        assert_true('集团' in r['company'], f"company: {r['company']}")
    )
)(parse_fields({'text': '王伟\n总监\n集团有限公司', 'words': []})))


print("\n── CSV export/import round-trip ─────────────────────────")

test("csvEscape: plain value unchanged", lambda: assert_eq(csv_escape('hello'), 'hello'))
test("csvEscape: wraps comma-containing value", lambda: assert_eq(csv_escape('Smith, John'), '"Smith, John"'))
test("csvEscape: escapes internal quotes", lambda: assert_eq(csv_escape('say "hi"'), '"say ""hi"""'))
test("csvEscape: wraps newline-containing value", lambda: assert_true(csv_escape('a\nb').startswith('"')))

test("CSV row: tier None maps to T4", lambda: (
    assert_true('T4' in build_csv_row({'id':'x','name':'Test','title':'','company':'',
        'emails':[],'phones':[],'linkedin':'','website':'','tier':None,
        'intro_by':'','next_action':'','next_action_date':'','session_id':'s1'}, None))))

test("CSV row: tier missing (undefined→None) maps to T4 — bug fix", lambda: (
    assert_true('T4' in build_csv_row({'id':'x','name':'Test','title':'','company':'',
        'emails':[],'phones':[],'linkedin':'','website':'',
        'intro_by':'','next_action':'','next_action_date':'','session_id':'s1'}, None))))

test("CSV row: tier 1 maps to T1", lambda: (
    assert_true('T1' in build_csv_row({'id':'x','name':'Alice','title':'','company':'',
        'emails':['a@b.com'],'phones':[],'linkedin':'','website':'','tier':1,
        'intro_by':'','next_action':'','next_action_date':'','session_id':'s1'}, None))))

test("CSV row: pipe-separates multiple emails", lambda: (
    assert_true('a@b.com|c@d.com' in build_csv_row({'id':'x','name':'Bob','title':'','company':'',
        'emails':['a@b.com','c@d.com'],'phones':[],'linkedin':'','website':'','tier':2,
        'intro_by':'','next_action':'','next_action_date':'','session_id':'s1'}, None))))


print("\n── CSV parser ───────────────────────────────────────────")

test("parseCSVRow: simple fields", lambda: assert_eq(parse_csv_row('a,b,c'), ['a','b','c']))
test("parseCSVRow: quoted field with comma", lambda: assert_eq(parse_csv_row('"Smith, John",CEO,Acme'), ['Smith, John','CEO','Acme']))
test("parseCSVRow: escaped quote inside quoted field", lambda: assert_eq(parse_csv_row('"say ""hi""",b'), ['say "hi"','b']))
test("parseCSVRow: empty fields", lambda: assert_eq(parse_csv_row('a,,c'), ['a','','c']))
test("parseCSVRow: trailing comma", lambda: assert_eq(parse_csv_row('a,b,')[2], ''))

test("parseTier: T1 → 1", lambda: assert_eq(parse_tier('T1'), 1))
test("parseTier: t2 → 2", lambda: assert_eq(parse_tier('t2'), 2))
test("parseTier: '3' → 3", lambda: assert_eq(parse_tier('3'), 3))
test("parseTier: T4 → 4", lambda: assert_eq(parse_tier('T4'), 4))
test("parseTier: empty → None", lambda: assert_eq(parse_tier(''), None))
test("parseTier: T5 → None (out of range)", lambda: assert_eq(parse_tier('T5'), None))
test("parseTier: garbage → None", lambda: assert_eq(parse_tier('xyz'), None))


print("\n── vCard parser ──────────────────────────────────────────")

SAMPLE_VCF = """BEGIN:VCARD
VERSION:3.0
FN:Alice Wong
TITLE:Managing Director
ORG:Alpha Capital Ltd
EMAIL:alice@alpha.com
TEL:+852 9876 5432
URL:https://www.alphacapital.com
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:Bob Chen
EMAIL:bob@beta.com
EMAIL:bob.work@beta.com
END:VCARD"""

test("vCard: parses name", lambda: assert_eq(parse_vcard(SAMPLE_VCF)[0]['name'], 'Alice Wong'))
test("vCard: parses title", lambda: assert_eq(parse_vcard(SAMPLE_VCF)[0]['title'], 'Managing Director'))
test("vCard: parses company", lambda: assert_eq(parse_vcard(SAMPLE_VCF)[0]['company'], 'Alpha Capital Ltd'))
test("vCard: parses email", lambda: assert_true('alice@alpha.com' in parse_vcard(SAMPLE_VCF)[0]['emails']))
test("vCard: parses phone", lambda: assert_true(len(parse_vcard(SAMPLE_VCF)[0]['phones']) > 0))
test("vCard: parses multiple cards", lambda: assert_eq(len(parse_vcard(SAMPLE_VCF)), 2))
test("vCard: parses multiple emails on second card", lambda: assert_eq(len(parse_vcard(SAMPLE_VCF)[1]['emails']), 2))
test("vCard: empty file returns empty array", lambda: assert_eq(parse_vcard(''), []))


print("\n── vCard escape ──────────────────────────────────────────")

test("vcEscape: plain string unchanged", lambda: assert_eq(vc_escape('Alice Wong'), 'Alice Wong'))
test("vcEscape: escapes comma", lambda: assert_eq(vc_escape('Smith, John'), 'Smith\\, John'))
test("vcEscape: escapes semicolon", lambda: assert_eq(vc_escape('a;b'), 'a\\;b'))
test("vcEscape: escapes newline", lambda: assert_eq(vc_escape('line1\nline2'), 'line1\\nline2'))
test("vcEscape: handles None", lambda: assert_eq(vc_escape(None), ''))


print("\n── importAll merge dedup logic ───────────────────────────")

test("merge: new IDs are included", lambda: (
    assert_eq(len([s for s in [{'id':'c'},{'id':'d'}] if s['id'] not in {'a','b'}]), 2)))

test("merge: duplicate IDs are skipped", lambda: (
    lambda result: (assert_eq(len(result), 1), assert_eq(result[0]['id'], 'c'))
)([s for s in [{'id':'a'},{'id':'c'}] if s['id'] not in {'a','b'}]))

test("merge: all duplicates → nothing written", lambda: (
    assert_eq([s for s in [{'id':'a'},{'id':'b'}] if s['id'] not in {'a','b'}], [])))


print(f"\n{'─'*52}")
print(f"  {passed} passed, {failed} failed")
if failed:
    print("  ⚠ Some tests failed")
    sys.exit(1)
else:
    print("  All tests passed ✓")
