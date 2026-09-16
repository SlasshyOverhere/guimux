"""Generate a minimal 1024x1024 PNG icon for Guimux without external deps."""
import struct, zlib, math

W = H = 1024

def px(x, y):
    # dark rounded square background
    margin = 64
    radius = 180
    in_bg = True
    # rounded-rect check
    cx = min(max(x, margin), W - margin)
    cy = min(max(y, margin), H - margin)
    inside = (x - margin < 0 or x > W - margin or y - margin < 0 or y > H - margin)
    dx = x - cx
    dy = y - cy
    dist = math.hypot(dx, dy)
    if inside and dist > radius - (0 if not inside else 0):
        pass
    # simpler: background is dark if within rounded rect
    def in_rounded(px_, py_, m, r):
        if px_ < m or px_ > W - m or py_ < m or py_ > H - m:
            # check corner circle
            cx_ = min(max(px_, m), W - m)
            cy_ = min(max(py_, m), H - m)
            return math.hypot(px_ - cx_, py_ - cy_) <= r
        return True
    if not in_rounded(x, y, margin, radius):
        return (0, 0, 0, 0)

    # terminal prompt: green ">" chevron + blue cursor block
    # chevron: two strokes forming >
    # stroke 1: from (280,340) to (480,512)
    # stroke 2: from (480,512) to (280,684)
    def seg_dist(px_, py_, ax, ay, bx, by):
        vx, vy = bx - ax, by - ay
        wx, wy = px_ - ax, py_ - ay
        t = max(0, min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
        dx_, dy_ = wx - t * vx, wy - t * vy
        return math.hypot(dx_, dy_)

    stroke = 56
    d1 = seg_dist(x, y, 300, 340, 520, 512)
    d2 = seg_dist(x, y, 520, 512, 300, 684)
    if min(d1, d2) < stroke / 2:
        return (152, 195, 121, 255)  # green

    # cursor block
    if 600 <= x <= 760 and 600 <= y <= 700:
        return (79, 140, 255, 255)  # blue

    # background
    return (16, 20, 27, 255)

rows = []
for y in range(H):
    row = bytearray()
    row.append(0)  # filter none
    for x in range(W):
        r, g, b, a = px(x, y)
        row += bytes((r, g, b, a))
    rows.append(bytes(row))

raw = b"".join(rows)

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

ihdr = struct.pack(">IIBBBBB", W, H, 8, 6, 0, 0, 0)
png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

with open("app-icon.png", "wb") as f:
    f.write(png)
print("wrote app-icon.png", len(png), "bytes")
