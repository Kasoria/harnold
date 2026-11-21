import math, os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logo")
STROKE = 32; HALF = STROKE/2
X_TOP, BASE, ASC = 80, 200, 30          # x-height top, baseline, ascender
RING_OUTER, RING_INNER = 62, 30          # o/a/d ring with overshoot
ARCH_OUTER = 56; ARCH_INNER = ARCH_OUTER-STROKE; ARCH_CY = 136

def fmt(v): return ('%.2f' % v).rstrip('0').rstrip('.')
def pill(x, y0, y1):  # vertical stem with round caps
    r = HALF
    return (f"M{fmt(x)} {fmt(y0+r)} A{r} {r} 0 0 1 {fmt(x+STROKE)} {fmt(y0+r)} V{fmt(y1-r)} "
            f"A{r} {r} 0 0 1 {fmt(x)} {fmt(y1-r)} Z")
def circle(cx, cy, r):
    return f"M{fmt(cx-r)} {fmt(cy)} A{r} {r} 0 1 0 {fmt(cx+r)} {fmt(cy)} A{r} {r} 0 1 0 {fmt(cx-r)} {fmt(cy)} Z"
def ring(cx, cy):  # outer cw, inner ccw -> hole with nonzero
    outer = f"M{fmt(cx-RING_OUTER)} {fmt(cy)} A{RING_OUTER} {RING_OUTER} 0 1 1 {fmt(cx+RING_OUTER)} {fmt(cy)} A{RING_OUTER} {RING_OUTER} 0 1 1 {fmt(cx-RING_OUTER)} {fmt(cy)} Z"
    inner = f"M{fmt(cx-RING_INNER)} {fmt(cy)} A{RING_INNER} {RING_INNER} 0 1 0 {fmt(cx+RING_INNER)} {fmt(cy)} A{RING_INNER} {RING_INNER} 0 1 0 {fmt(cx-RING_INNER)} {fmt(cy)} Z"
    return outer + " " + inner
def arch(cx, end_deg=0):
    """Upper annulus band from 180° to end_deg (math angles, y up)."""
    def pt(r, d): return cx + r*math.cos(math.radians(d)), ARCH_CY - r*math.sin(math.radians(d))
    large = 1 if 180-end_deg > 180 else 0
    ox0, oy0 = pt(ARCH_OUTER, 180); ox1, oy1 = pt(ARCH_OUTER, end_deg)
    ix1, iy1 = pt(ARCH_INNER, end_deg); ix0, iy0 = pt(ARCH_INNER, 180)
    d = (f"M{fmt(ox0)} {fmt(oy0)} A{ARCH_OUTER} {ARCH_OUTER} 0 {large} 1 {fmt(ox1)} {fmt(oy1)} "
         f"L{fmt(ix1)} {fmt(iy1)} A{ARCH_INNER} {ARCH_INNER} 0 {large} 0 {fmt(ix0)} {fmt(iy0)} Z")
    return d, pt((ARCH_OUTER+ARCH_INNER)/2, end_deg)

parts = []; x = 0
def letter_n_like(x, top):   # h (top=ASC) or n (top=X_TOP)
    cx = x + ARCH_OUTER
    band, _ = arch(cx, 0)
    parts.extend([pill(x, top, BASE), band, pill(cx+ARCH_OUTER-STROKE, 120, BASE)])
    return x + 2*ARCH_OUTER
def letter_ring_stem(x, top):  # a (top=X_TOP) or d (top=ASC)
    cx = x + RING_OUTER
    parts.extend([ring(cx, 140), pill(cx+RING_INNER, top, BASE)])
    return cx + RING_OUTER
def letter_r(x):
    cx = x + ARCH_OUTER
    band, (tx, ty) = arch(cx, 62)
    parts.extend([pill(x, X_TOP, BASE), band, circle(tx, ty, HALF)])
    return tx + HALF
def letter_o(x):
    cx = x + RING_OUTER; parts.append(ring(cx, 140)); return cx + RING_OUTER
def letter_l(x):
    parts.append(pill(x, ASC, BASE)); return x + STROKE

GAP_STRAIGHT, GAP_ROUND = 26, 20
x = letter_n_like(0, ASC)               # h
x = letter_ring_stem(x + GAP_ROUND, X_TOP)  # a
x = letter_r(x + GAP_STRAIGHT)          # r
x = letter_n_like(x + 14, X_TOP)        # n
x = letter_o(x + GAP_ROUND)             # o
x = letter_l(x + GAP_ROUND)             # l
x = letter_ring_stem(x + GAP_ROUND, ASC)    # d
WORD_W = x
WORD_PATH = "".join(f'<path d="{d}"/>' for d in parts)

SYMBOL_INNER = '''<path d="M14 112 Q128 168 242 112" fill="none" stroke="{c}" stroke-width="24" stroke-linecap="round"/>
<rect x="47" y="38" width="54" height="180" rx="27" fill="{c}" transform="rotate(10 74 128)"/>
<rect x="155" y="38" width="54" height="180" rx="27" fill="{c}" transform="rotate(-10 182 128)"/>'''
SMALL_INNER = '''<path d="M18 110 Q128 160 238 110" fill="none" stroke="{c}" stroke-width="34" stroke-linecap="round"/>
<rect x="42" y="36" width="64" height="184" rx="32" fill="{c}" transform="rotate(10 74 128)"/>
<rect x="150" y="36" width="64" height="184" rx="32" fill="{c}" transform="rotate(-10 182 128)"/>'''

def svg(vb, body, title="Harnold"):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}"><title>{title}</title>{body}</svg>\n'
def write(name, content): open(os.path.join(OUT, name), "w").write(content)

INK = "#121210"
write("harnold-symbol.svg", svg("0 0 256 256", SYMBOL_INNER.format(c=INK)))
write("harnold-symbol-small.svg", svg("0 0 256 256", SMALL_INNER.format(c=INK)))
# Wortmarke: Buchstaben 30..200 hoch -> in 256-Höhe zentrieren
write("harnold-wordmark.svg", svg(f"-8 0 {fmt(WORD_W+16)} 230", f'<g fill="{INK}">{WORD_PATH}</g>'))
# Horizontal: Symbol 256, Wort skaliert auf Ascender-Höhe ~ Symbolhöhe*0.66
def horizontal(sym_c, word_c):
    s = 1.0; gap = 52
    body = f'<g>{SYMBOL_INNER.format(c=sym_c)}</g><g transform="translate({256+gap} 25) scale({s})"><g fill="{word_c}">{WORD_PATH}</g></g>'
    return svg(f"0 0 {fmt(256+gap+WORD_W*s+8)} 256", body)
def stacked(sym_c, word_c):
    s = 0.5; w = WORD_W*s; total_w = max(256, w)
    body = (f'<g transform="translate({fmt((total_w-256)/2)} 0)">{SYMBOL_INNER.format(c=sym_c)}</g>'
            f'<g transform="translate({fmt((total_w-w)/2)} {fmt(270-ASC*s)}) scale({s})"><g fill="{word_c}">{WORD_PATH}</g></g>')
    return svg(f"0 0 {fmt(total_w)} {fmt(270+(BASE-ASC)*s+8)}", body)
BLUE = "#0F4BF7"
write("harnold-horizontal.svg", horizontal(INK, INK))
write("harnold-horizontal-color.svg", horizontal(BLUE, INK))
write("harnold-stacked.svg", stacked(INK, INK))
write("harnold-stacked-color.svg", stacked(BLUE, INK))
write("harnold-symbol-color.svg", svg("0 0 256 256", SYMBOL_INNER.format(c=BLUE)))
write("harnold-horizontal-white.svg", horizontal("#FFFFFF", "#FFFFFF"))
print("word width", WORD_W)
