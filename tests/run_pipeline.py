#!/usr/bin/env python3
"""
Headless port of the browser pipeline for offline testing.

Mirrors docs/js/detect.js (multi-strategy card detection with IoU merging) and
docs/js/ocr.js (OCR preprocessing + field parser). Not a bit-exact copy — the
browser uses OpenCV.js + Tesseract.js which have tiny behavioral differences
from desktop OpenCV/Tesseract — but close enough to predict real output.
"""
import os, re, sys, json, math
import cv2
import numpy as np
import pytesseract
from pathlib import Path

TEST_DIR = Path(__file__).parent / "Test Case"
OUT_DIR = Path(__file__).parent / "output"
OUT_DIR.mkdir(exist_ok=True)

# ─── Detection ──────────────────────────────────────────────────────────────

def detect_cards(img_bgr):
    fullH, fullW = img_bgr.shape[:2]
    DETECT_MAX = 1200
    longest = max(fullW, fullH)
    scale = DETECT_MAX / longest if longest > DETECT_MAX else 1.0
    detectW, detectH = int(round(fullW * scale)), int(round(fullH * scale))
    if scale < 1:
        src = cv2.resize(img_bgr, (detectW, detectH), interpolation=cv2.INTER_AREA)
    else:
        src = img_bgr
    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    min_area = detectW * detectH * 0.02

    canny_cards = [(*c, 'canny') for c in detect_canny(gray, min_area)]
    otsu_cards = [(*c, 'otsu') for c in detect_otsu(gray, min_area)]
    adapt_cards = [(*c, 'adaptive') for c in detect_adaptive(gray, min_area)]

    all_cands = canny_cards + otsu_cards + adapt_cards
    merged = merge_by_iou(all_cands)

    # Size-similarity filter: all cards in one photo should be roughly the
    # same size. Drop outliers more than 4× away from the median area.
    if len(merged) > 1:
        areas = sorted(m[1] for m in merged)
        median = areas[len(areas)//2]
        merged = [m for m in merged if median/4 <= m[1] <= median*4]

    cards = []
    for corners, area, sources in merged:
        # scale back to full-res
        full_corners = np.array([[x/scale, y/scale] for x, y in corners], dtype=np.float32)
        ordered = order_corners(full_corners)
        crop = dewarp(img_bgr, ordered)
        cards.append({
            'corners': ordered.tolist(),
            'crop': crop,
            'area': area / (scale*scale),
            'confidence': len(sources),
            'sources': list(sources),
        })
    cards.sort(key=lambda c: (-c['confidence'], -c['area']))
    return cards, (fullW, fullH)


def detect_otsu(gray, min_area):
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    return extract_from_binary(closed, min_area)


def detect_adaptive(gray, min_area):
    binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
                                    cv2.THRESH_BINARY, 51, 5)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel)
    return extract_from_binary(closed, min_area)


def detect_canny(gray, min_area):
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    cards = []
    for lo, hi in [(30, 90), (50, 150), (80, 200)]:
        edges = cv2.Canny(blurred, lo, hi)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
        dilated = cv2.dilate(edges, kernel)
        cards.extend(extract_from_binary(dilated, min_area))
    return cards


def extract_from_binary(binary, min_area):
    h, w = binary.shape[:2]
    max_area = w * h * 0.5  # nothing > 50% of frame is a card
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cards = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area or area > max_area: continue
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.03 * peri, True)
        corners4 = None
        if 4 <= len(approx) <= 8:
            raw = [(p[0][0], p[0][1]) for p in approx]
            corners4 = raw if len(approx) == 4 else reduce_to_four(raw)
        else:
            rect = cv2.minAreaRect(cnt)
            (cx, cy), (w, h), ang = rect
            if w > 0 and h > 0:
                aspect = max(w, h) / min(w, h)
                if 1.3 <= aspect <= 2.5:
                    box = cv2.boxPoints(rect)
                    corners4 = [(p[0], p[1]) for p in box]
        if corners4:
            xs, ys = zip(*corners4)
            bw, bh = max(xs)-min(xs), max(ys)-min(ys)
            if bw > 0 and bh > 0:
                aspect = max(bw, bh) / min(bw, bh)
                if 1.3 <= aspect <= 2.8:
                    cards.append((corners4, area))
    return cards


def merge_by_iou(all_cands):
    # sort by area desc
    sorted_c = sorted(all_cands, key=lambda c: -c[1])
    groups = []
    for corners, area, source in sorted_c:
        box = bbox(corners)
        match = None
        for g in groups:
            if iou(box, g['box']) > 0.5:
                match = g; break
        if match:
            match['sources'].add(source)
        else:
            groups.append({'corners': corners, 'area': area, 'box': box,
                           'sources': {source}})
    return [(g['corners'], g['area'], g['sources']) for g in groups]


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    aA = (a[2]-a[0]) * (a[3]-a[1])
    bA = (b[2]-b[0]) * (b[3]-b[1])
    u = aA + bA - inter
    return inter/u if u > 0 else 0


def bbox(corners):
    xs, ys = zip(*corners)
    return (min(xs), min(ys), max(xs), max(ys))


def reduce_to_four(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    minX, maxX = min(xs), max(xs); minY, maxY = min(ys), max(ys)
    def closest(cx, cy):
        return min(pts, key=lambda p: math.hypot(p[0]-cx, p[1]-cy))
    return [closest(minX, minY), closest(maxX, minY),
            closest(maxX, maxY), closest(minX, maxY)]


def order_corners(pts):
    pts = np.array(pts, dtype=np.float32)
    # sort by y
    idx = np.argsort(pts[:, 1])
    top = pts[idx[:2]]; bot = pts[idx[2:]]
    top = top[np.argsort(top[:, 0])]
    bot = bot[np.argsort(bot[:, 0])]
    return np.array([top[0], top[1], bot[1], bot[0]], dtype=np.float32)


def dewarp(img, corners):
    tl, tr, br, bl = corners
    wTop = np.linalg.norm(tr - tl); wBot = np.linalg.norm(br - bl)
    hL = np.linalg.norm(bl - tl); hR = np.linalg.norm(br - tr)
    maxW = int(round(max(wTop, wBot))); maxH = int(round(max(hL, hR)))
    if maxW < 10 or maxH < 10:
        return img
    dst = np.array([[0,0],[maxW-1,0],[maxW-1,maxH-1],[0,maxH-1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(corners, dst)
    return cv2.warpPerspective(img, M, (maxW, maxH))


# ─── OCR preprocess & run ──────────────────────────────────────────────────

def deskew(img_bgr):
    """Detect dominant text-line angle and counter-rotate. +10% OCR typ."""
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kW = max(15, img_bgr.shape[1] // 30)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kW, 3))
    dilated = cv2.dilate(binary, kernel)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_bar_area = img_bgr.shape[0] * img_bgr.shape[1] * 0.002
    angles = []
    for cnt in contours:
        if cv2.contourArea(cnt) < min_bar_area: continue
        rect = cv2.minAreaRect(cnt)
        (_, _), (rw, rh), ang = rect
        if rw < rh: ang += 90
        if ang > 45: ang -= 90
        if ang < -45: ang += 90
        if abs(ang) <= 15:
            angles.append(ang)
    if not angles: return img_bgr
    median_angle = sorted(angles)[len(angles)//2]
    if abs(median_angle) < 0.5: return img_bgr
    h, w = img_bgr.shape[:2]
    M = cv2.getRotationMatrix2D((w//2, h//2), median_angle, 1.0)
    return cv2.warpAffine(img_bgr, M, (w, h), flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_REPLICATE)


def preprocess_for_ocr(img_bgr):
    img_bgr = deskew(img_bgr)
    TARGET = 1500
    h, w = img_bgr.shape[:2]
    longest = max(w, h)
    scale = TARGET/longest if longest < TARGET else 1.0
    if scale != 1.0:
        img_bgr = cv2.resize(img_bgr, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_CUBIC)
    h2, w2 = img_bgr.shape[:2]
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    k = int(w2 / 8) | 1
    bg = cv2.GaussianBlur(gray, (k, k), 0)
    grayF = gray.astype(np.float32)
    bgF   = bg.astype(np.float32)
    normF = np.clip(grayF / (bgF + 1e-6) * 128, 0, 255).astype(np.uint8)
    clahe = cv2.createCLAHE(clipLimit=1.5, tileGridSize=(8,8))
    return clahe.apply(normF)


def run_ocr(img_gray):
    # PSM 6 = single uniform block of text; eng+chi_sim
    cfg = '--psm 6'
    text = pytesseract.image_to_string(img_gray, lang='eng+chi_sim', config=cfg)
    return text


# ─── Field parser (ports ocr.js) ───────────────────────────────────────────

TITLE_KEYWORDS = ['director','manager','vp ','v.p.','ceo','cfo','coo','cto','cmo',
    'founder','partner','head ','senior','associate','analyst','officer','president',
    'principal','vice','managing','executive','lead','specialist',
    '总监','经理','总裁','董事','主任','首席']
COMPANY_KEYWORDS = ['ltd','llc','pte','inc','corp','group','capital','fund','partners',
    'holdings','ventures','management','advisory','consulting','securities',
    'investments','financial','bank','asset','equity','solutions','berhad','authority',
    'university','school','department',
    '有限公司','集团','基金','证券','投资','资产']


def parse_fields(text):
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    emails = extract_emails(text)
    phones = extract_phones(text, emails)
    linkedin = extract_linkedin(text)
    website = extract_website(text, emails, linkedin)
    consumed = set()
    for v in emails + phones: mark(consumed, lines, v)
    if linkedin: mark(consumed, lines, linkedin)
    if website: mark(consumed, lines, website)
    remaining = [l for i,l in enumerate(lines) if i not in consumed]
    name = extract_name(remaining)
    title = extract_title(remaining, name)
    company = extract_company(remaining, name, title)
    return dict(name=name or '', title=title or '', company=company or '',
                emails=emails, phones=phones, linkedin=linkedin or '',
                website=website or '', raw_text=text)


def extract_emails(t):
    return list(dict.fromkeys(re.findall(r'[\w.+\-]+@[\w\-.]+\.[a-z]{2,6}', t, re.I)))


def extract_phones(text, emails):
    email_str = ' '.join(emails)
    found = []
    for line in text.split('\n'):
        if re.search(r'\d{6,}\s*\(\s*[\w-]+\s*\)', line):
            continue
        # Clean intra-digit punctuation noise (apostrophes, backticks, colons between digits)
        line = re.sub(r"(\d)['`:](\d)", r'\1\2', line)
        # Normalize trailing layout markers like " | T Pp"
        line = re.sub(r'\s*\|\s*[a-zA-Z]{1,3}(\s+[a-zA-Z]{1,2})?\s*\|?\s*$', '', line)
        # OCR confusion: leading 4/T/F/H/#/$ before a phone-shaped digit run → +
        line = re.sub(r'(^|[\s(])[4TFH#$](\d{2,3})', r'\1+\2', line)
        for m in re.findall(r'(\+?[\d][\d\s\-().]{6,18}[\d])', line):
            cleaned = m.strip()
            digits = re.sub(r'\D', '', cleaned)
            if len(digits) < 7 or len(digits) > 15: continue
            if cleaned in email_str: continue
            if len(digits) >= 10 and not re.search(r'[\s\-+()]', cleaned): continue
            if not cleaned.startswith('+') and not re.search(r'[\s\-]', cleaned): continue
            found.append(cleaned)
    return list(dict.fromkeys(found))


def extract_linkedin(t):
    m = re.search(r'linkedin\.com/in/[\w\-]+', t, re.I)
    return m.group(0) if m else None


def extract_website(text, emails, linkedin):
    email_domains = [e.split('@')[1] for e in emails if '@' in e]
    cands = re.findall(r'(?:https?://)?[\w\-]+\.(?:com|co|io|net|org|hk|sg|cn|edu|edu\.sg|com\.cn|com\.hk|com\.my)(?:/[\w.\-/?=&#%]*)?',
                        text, re.I)
    for c in cands:
        clean = re.sub(r'^https?://', '', c).lower()
        if linkedin and 'linkedin' in clean: continue
        if any(clean.startswith(d) or d.startswith(clean.split('/')[0]) for d in email_domains):
            continue
        return c
    return None


def mark(consumed, lines, val):
    v = val.lower()
    for i, l in enumerate(lines):
        if v in l.lower(): consumed.add(i)


def real_wc(line):
    return len([t for t in line.split() if len(t) > 1])

def name_score(line, idx):
    rwc = real_wc(line)
    score = 0
    if 2 <= rwc <= 5:
        score += 10
    elif rwc == 1:
        score -= 3
        score += min(3, idx * 0.5)  # logos at top; names appear below
    cjk_count = len(re.findall(r'[\u4e00-\u9fff]', line))
    if cjk_count >= 2 and re.search(r'[A-Za-z]', line):
        score += 5
    return score

def extract_name(lines):
    candidates = [(i, l) for i, l in enumerate(lines)
                  if 1 <= real_wc(l) <= 5
                  and not looks_keyword(l)
                  and not re.search(r'\d', l)]  # any digit disqualifies
    if not candidates: return None
    candidates.sort(key=lambda x: name_score(x[1], x[0]), reverse=True)
    return candidates[0][1]


def extract_title(lines, name):
    for line in lines:
        if name and line == name: continue
        lower = line.lower()
        if any(k in lower for k in TITLE_KEYWORDS): return line
    if name and name in lines:
        idx = lines.index(name)
        if idx+1 < len(lines): return lines[idx+1]
    return None


def extract_company(lines, name, title):
    for line in lines:
        if name and line == name: continue
        if title and line == title: continue
        lower = line.lower()
        if any(k in lower for k in COMPANY_KEYWORDS): return line
    rest = [l for l in lines if l != name and l != title]
    return rest[-1] if rest else None


def looks_keyword(line):
    lower = line.lower()
    return any(k in lower for k in TITLE_KEYWORDS + COMPANY_KEYWORDS)


# ─── Runner ────────────────────────────────────────────────────────────────

def test_image(path):
    print(f"\n{'='*70}")
    print(f"TEST: {path.name}")
    print('='*70)
    img = cv2.imread(str(path))
    if img is None:
        print(f"  ERROR: could not read {path}")
        return
    cards, (w, h) = detect_cards(img)
    print(f"  Image: {w}×{h}")
    print(f"  Cards detected: {len(cards)}")
    for i, c in enumerate(cards):
        print(f"    #{i+1}: confidence={c['confidence']} sources={c['sources']} area={int(c['area'])}")

    for i, c in enumerate(cards):
        if c.get('isFallback'): continue
        # save dewarped crop for inspection
        crop_path = OUT_DIR / f"{path.stem}_card{i+1}.jpg"
        cv2.imwrite(str(crop_path), c['crop'])
        # OCR
        prepped = preprocess_for_ocr(c['crop'])
        prep_path = OUT_DIR / f"{path.stem}_card{i+1}_prep.jpg"
        cv2.imwrite(str(prep_path), prepped)
        text = run_ocr(prepped)
        parsed = parse_fields(text)
        print(f"\n  ── Card {i+1} (conf={c['confidence']}) ──────────────────────────")
        print(f"    Name:     {parsed['name']}")
        print(f"    Title:    {parsed['title']}")
        print(f"    Company:  {parsed['company']}")
        print(f"    Emails:   {parsed['emails']}")
        print(f"    Phones:   {parsed['phones']}")
        print(f"    Website:  {parsed['website']}")
        print(f"    --- raw OCR ---")
        for line in text.splitlines():
            if line.strip():
                print(f"    | {line}")


if __name__ == '__main__':
    files = sorted(TEST_DIR.glob('*.JPG')) + sorted(TEST_DIR.glob('*.jpg'))
    for f in files:
        test_image(f)
