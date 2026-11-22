"""Renders the exercise animations in img/exercises/: a smooth grey 3D figure on a white
background doing each exercise, with the muscles it works in red.

Run from the site folder (needs numpy and Pillow):
    python3 tools/make_exercise_gifs.py                 every exercise (about 3 minutes each on 8 cores)
    python3 tools/make_exercise_gifs.py squat plank     only these
    python3 tools/make_exercise_gifs.py --preview squat quick low-resolution stills in img/_preview_*.png

The figure is built from smooth 3D shapes (ellipsoids and tapered capsules blended
together) and drawn by ray marching a signed distance field, with soft lighting,
ambient occlusion and a soft floor shadow.

Poses
-----
Angles are in degrees and give the direction of a body segment in the side-on plane:
0 points down, 90 points forward (the way the figure faces), 180 points up, 270 back.
A key ending in _n applies to the near side only (the side facing the camera), _f to
the far side; without a suffix it applies to both.

Standing poses give 'toe' (where the toes rest) and the directions ankle→knee ('shin'),
knee→hip ('thigh') and hip→neck ('torso'), all built up from the floor.

Free poses give 'hip' (x, y) and build the legs downward: 'hip_k' (hip→knee), 'knee_a'
(knee→ankle), 'foot' (ankle→toe) and 'leg_out' (legs spread sideways). 'ground' lists
joints that rest on the floor; the figure is moved up or down so the lowest of them
touches it. 'shoulder_y' tilts the torso so the shoulders are at that height.

Arms use 'upper' (shoulder→elbow) and 'fore' (elbow→wrist), or 'hand' (x, y) to reach
a point, or 'hand_floor' (an x offset from the shoulder) to put the hands on the floor,
and 'arm_out' to raise them sideways. 'air' lifts the whole figure (for jumps).
"""
import math
import os
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image

OUT = 320  # output size in pixels
SS = 2  # rendered this many times larger, then shrunk, for smooth edges
FRAMES = 40
FRAME_MS = 55
HOLD = 4  # frames held at each end of the movement

BODY = np.array([0.80, 0.81, 0.84], np.float32)
MUSCLE = np.array([0.86, 0.15, 0.13], np.float32)
PROP = np.array([0.40, 0.41, 0.44], np.float32)
PANEL = np.array([0.86, 0.86, 0.88], np.float32)

# Body measurements, metres.
L = dict(shin=0.43, thigh=0.45, torso=0.47, upper=0.29, fore=0.26, foot=0.165)
HIP_Z = 0.09
SHOULDER_Z = 0.19
ARM_Z = (SHOULDER_Z, 0.215, 0.225)  # shoulder, elbow and wrist distance from the middle
CONTACT = dict(toe=0.026, heel=0.034, knee=0.05, ankle=0.04)

# ---------- maths helpers ----------


def d2(a):
    """Direction in the side-on plane: 0 down, 90 forward, 180 up."""
    r = math.radians(a)
    return np.array([math.sin(r), -math.cos(r)])


def dir3(a, out=0.0, side=1):
    """3D direction: angle a in the side-on plane, then swung out sideways by 'out'
    degrees (0 hanging, 90 straight out to the side, 180 overhead)."""
    r = math.radians(a)
    vx, vy = math.sin(r), -math.cos(r)
    if not out:
        return np.array([vx, vy, 0.0])
    c = math.radians(out)
    return np.array([vx, vy * math.cos(c), -vy * math.sin(c) * side])


def lerp(a, b, t):
    return a + (b - a) * t


def ease(t):
    return 0.5 - 0.5 * math.cos(math.pi * t)


def unit(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v)
    return v / (n or 1)


def ik(shoulder, hand, l1, l2, elbow_down=True):
    """Elbow (or knee) position for a two-part limb reaching from shoulder to hand, in
    the side-on plane."""
    d = hand - shoulder
    dist = min(float(np.hypot(*d)), l1 + l2 - 1e-3)
    a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    u = d / (np.hypot(*d) or 1)
    m = shoulder + u * a
    n = np.array([u[1], -u[0]]) if elbow_down else np.array([-u[1], u[0]])
    return m + n * h


def frame3(e1, ref=None):
    """Orthonormal frame whose first axis is e1. The second axis is the 'front' of the
    segment: e1 turned 90 degrees forward in the side-on plane."""
    e1 = unit(e1)
    if ref is None:
        ref = np.array([-e1[1], e1[0], 0.0])
        if np.linalg.norm(ref) < 0.2:
            ref = np.array([1.0, 0.0, 0.0])
    e2 = unit(ref - (ref @ e1) * e1)
    return e1, e2, np.cross(e1, e2)


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b + (a - b) * h - k * h * (1.0 - h)


# ---------- signed distance primitives (points as separate x, y, z arrays) ----------


def sd_ellipsoid(x, y, z, c, f, r):
    """Ellipsoid centred at c, axes along frame f = (e1, e2, e3), radii r."""
    dx, dy, dz = x - c[0], y - c[1], z - c[2]
    e1, e2, e3 = f
    a = dx * e1[0] + dy * e1[1] + dz * e1[2]
    b = dx * e2[0] + dy * e2[1] + dz * e2[2]
    w = dx * e3[0] + dy * e3[1] + dz * e3[2]
    k0 = np.sqrt((a / r[0]) ** 2 + (b / r[1]) ** 2 + (w / r[2]) ** 2)
    k1 = np.sqrt((a / r[0] ** 2) ** 2 + (b / r[1] ** 2) ** 2 + (w / r[2] ** 2) ** 2)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-6)


def sd_round_cone(x, y, z, a, b, r1, r2):
    """Capsule from a (radius r1) to b (radius r2), smoothly tapered."""
    ba = b - a
    l2 = float(ba @ ba)
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    px, py, pz = x - a[0], y - a[1], z - a[2]
    yy = px * ba[0] + py * ba[1] + pz * ba[2]
    zz = yy - l2
    qx, qy, qz = px * l2 - ba[0] * yy, py * l2 - ba[1] * yy, pz * l2 - ba[2] * yy
    x2 = qx * qx + qy * qy + qz * qz
    y2 = yy * yy * l2
    z2 = zz * zz * l2
    k = math.copysign(1, rr) * rr * rr * x2
    end_b = np.sqrt(x2 + z2) * il2 - r2
    end_a = np.sqrt(x2 + y2) * il2 - r1
    side = (np.sqrt(np.maximum(x2 * a2 * il2, 0)) + yy * rr) * il2 - r1
    return np.where(np.sign(zz) * a2 * z2 > k, end_b, np.where(np.sign(yy) * a2 * y2 < k, end_a, side))


def sd_box(x, y, z, c, h, r=0.0):
    qx, qy, qz = np.abs(x - c[0]) - h[0], np.abs(y - c[1]) - h[1], np.abs(z - c[2]) - h[2]
    out = np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qy, 0) ** 2 + np.maximum(qz, 0) ** 2)
    return out + np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0) - r


def sd_cyl_z(x, y, z, c, r, h):
    """Cylinder along z."""
    dr = np.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2) - r
    dz = np.abs(z - c[2]) - h
    return np.minimum(np.maximum(dr, dz), 0) + np.sqrt(np.maximum(dr, 0) ** 2 + np.maximum(dz, 0) ** 2)


# ---------- skeleton ----------

SIDES = (1, -1)  # near (towards the camera), far


def get(pose, key, s, default=None):
    side_key = key + ('_n' if s > 0 else '_f')
    return pose[side_key] if side_key in pose else pose.get(key, default)


def v3(p, z):
    return np.array([p[0], p[1], z], float)


def leg_points(ankle, toe, fd):
    """Heel from the ankle and the foot's direction."""
    down = np.array([fd[1], -fd[0], 0.0])
    return ankle - fd * 0.045 + down * 0.035


def skeleton(pose):
    """3D joint positions (x forward, y up, z to the near side, metres) for a pose."""
    legs = {}
    if 'hip' not in pose:
        # standing: built up from the toes, the same on both sides
        fd2 = d2(pose.get('foot', 71))
        toe = np.array(pose['toe'], float) + np.array([0, pose.get('air', 0.0)])
        ankle = toe - fd2 * L['foot']
        knee = ankle + d2(pose['shin']) * L['shin']
        hip = knee + d2(pose['thigh']) * L['thigh']
        for s in SIDES:
            z = s * HIP_Z
            fd = np.array([fd2[0], fd2[1], 0.0])
            legs[s] = dict(hip=v3(hip, z), knee=v3(knee, z), ankle=v3(ankle, z), toe=v3(toe, z), fd=fd,
                           heel=leg_points(v3(ankle, z), v3(toe, z), fd))
    else:
        # free: built down from the hip, each side on its own
        hip = np.array(pose['hip'], float)
        for s in SIDES:
            out = get(pose, 'leg_out', s, 0.0)
            h3 = v3(hip, s * HIP_Z)
            knee = h3 + dir3(get(pose, 'hip_k', s, 0), out, s) * L['thigh']
            ankle = knee + dir3(get(pose, 'knee_a', s, 0), out, s) * L['shin']
            fd = dir3(get(pose, 'foot', s, 71))
            toe = ankle + fd * L['foot']
            legs[s] = dict(hip=h3, knee=knee, ankle=ankle, toe=toe, fd=fd, heel=leg_points(ankle, toe, fd))
        ground = pose.get('ground')
        dy = 0.0
        if ground:
            ys = []
            for name in ground:
                base, _, side = name.partition('_')
                for s in SIDES:
                    if not side or (side == 'n') == (s > 0):
                        ys.append(legs[s][base][1] - CONTACT[base])
            dy = -min(ys)
        dy += pose.get('air', 0.0)
        hip = hip + np.array([0, dy])
        for s in SIDES:
            for k in ('hip', 'knee', 'ankle', 'toe', 'heel'):
                legs[s][k] = legs[s][k] + np.array([0, dy, 0])

    torso = pose['torso']
    if 'shoulder_y' in pose:
        c = np.clip((hip[1] - pose['shoulder_y']) / (L['torso'] - 0.035), -1, 1)
        torso = math.degrees(math.acos(c))
    u = d2(torso)
    neck = hip + u * L['torso']
    head = neck + d2(torso + pose.get('head', 0)) * 0.17
    shoulder = neck - u * 0.035

    arms = {}
    az = pose.get('arm_z', ARM_Z)
    for s in SIDES:
        sh3 = v3(shoulder, s * az[0])
        out = get(pose, 'arm_out', s)
        hand = get(pose, 'hand', s)
        floor = get(pose, 'hand_floor', s)
        if floor is not None:
            hand = (shoulder[0] + floor, 0.10)
        if hand is not None:
            hand = np.array(hand, float)
            el2 = ik(shoulder, hand, L['upper'], L['fore'], pose.get('elbow_down', True))
            elbow, wrist = v3(el2, s * az[1]), v3(hand, s * az[2])
        elif out is not None:
            elbow = sh3 + dir3(get(pose, 'upper', s, 6), out, s) * L['upper']
            wrist = elbow + dir3(get(pose, 'fore', s, 10), out, s) * L['fore']
        else:
            el2 = shoulder + d2(get(pose, 'upper', s, 6)) * L['upper']
            wr2 = el2 + d2(get(pose, 'fore', s, 10)) * L['fore']
            elbow, wrist = v3(el2, s * az[1]), v3(wr2, s * az[2])
        arms[s] = dict(shoulder=sh3, elbow=elbow, wrist=wrist)
    return dict(hip=hip, neck=neck, head=head, shoulder=shoulder, u=u, legs=legs, arms=arms)


# ---------- the figure ----------


class Figure:
    """The parts of the body for one pose. Each part is (sdf function, muscle tag)."""

    def __init__(self, j):
        self.torso, self.legs, self.arms = [], [], []
        u, hip, neck = j['u'], j['hip'], j['neck']
        fwd = np.array([u[1], -u[0]])
        tf = (np.array([u[0], u[1], 0.0]), np.array([fwd[0], fwd[1], 0.0]), np.array([0.0, 0.0, 1.0]))
        at = lambda along, front=0.0, z=0.0: v3(hip + u * along + fwd * front, z)
        T = self.torso

        def ell(c, r, tag=None, f=tf, group=T):
            group.append((lambda x, y, z, c=c, f=f, r=r: sd_ellipsoid(x, y, z, c, f, r), tag))

        # trunk
        ell(at(0.05), (0.115, 0.105, 0.155))
        ell(at(0.21), (0.13, 0.095, 0.135))
        ell(at(0.34, 0.005), (0.15, 0.11, 0.16))
        ell(v3(neck - u * 0.05 - fwd * 0.02, 0), (0.06, 0.07, 0.15))  # trapezius
        ell(at(0.20, 0.075), (0.13, 0.03, 0.075), 'abs')
        for s in SIDES:
            ell(at(0.36, 0.075, s * 0.072), (0.07, 0.04, 0.075), 'chest')
            ell(at(0.0, -0.055, s * 0.072), (0.09, 0.07, 0.08), 'glutes')
            ell(at(0.30, -0.045, s * 0.115), (0.12, 0.04, 0.05), 'lats')
            ell(at(0.13, -0.075, s * 0.04), (0.11, 0.03, 0.035), 'lower_back')
        # neck and head
        T.append((lambda x, y, z, a=v3(neck - u * 0.02, 0), b=v3(j['head'] - u * 0.05, 0):
                  sd_round_cone(x, y, z, a, b, 0.055, 0.045), None))
        hu = d2(math.degrees(math.atan2(j['head'][0] - neck[0], -(j['head'][1] - neck[1]))))
        hf = np.array([hu[1], -hu[0]])
        head_f = (np.array([hu[0], hu[1], 0.0]), np.array([hf[0], hf[1], 0.0]), np.array([0.0, 0.0, 1.0]))
        ell(v3(j['head'], 0), (0.115, 0.095, 0.085), f=head_f)
        ell(v3(j['head'] - hu * 0.055 + hf * 0.03, 0), (0.055, 0.06, 0.06), f=head_f)  # jaw

        for s in SIDES:
            lg, leg = j['legs'][s], []
            ta = frame3(lg['knee'] - lg['hip'])
            sa = frame3(lg['ankle'] - lg['knee'])
            leg.append((lambda x, y, z, a=lg['hip'], b=lg['knee']: sd_round_cone(x, y, z, a, b, 0.075, 0.05), None))
            ell(lg['hip'] + ta[0] * 0.22 + ta[1] * 0.025, (0.17, 0.055, 0.06), 'quads', ta, leg)
            ell(lg['hip'] + ta[0] * 0.22 - ta[1] * 0.028, (0.15, 0.045, 0.055), 'hamstrings', ta, leg)
            leg.append((lambda x, y, z, a=lg['knee'], b=lg['ankle']: sd_round_cone(x, y, z, a, b, 0.048, 0.031), None))
            ell(lg['knee'] + sa[0] * 0.13 - sa[1] * 0.03, (0.11, 0.043, 0.045), 'calves', sa, leg)
            heel = lg['heel']
            toe = lg['toe'] + lg['fd'] * 0.05
            leg.append((lambda x, y, z, a=heel, b=toe: sd_round_cone(x, y, z, a, b, 0.034, 0.024), None))
            leg.append((lambda x, y, z, c=lg['ankle']: np.sqrt((x - c[0]) ** 2 + (y - c[1]) ** 2 + (z - c[2]) ** 2) - 0.036, None))
            self.legs.append(leg)

        self.hands = []
        for s in SIDES:
            am, arm = j['arms'][s], []
            ua = frame3(am['elbow'] - am['shoulder'])
            fa = frame3(am['wrist'] - am['elbow'])
            ell(am['shoulder'] + ua[0] * 0.02, (0.075, 0.055, 0.055), 'shoulders', ua, T)  # deltoid
            arm.append((lambda x, y, z, a=am['shoulder'], b=am['elbow']: sd_round_cone(x, y, z, a, b, 0.046, 0.035), None))
            ell(am['shoulder'] + ua[0] * 0.15 + ua[1] * 0.02, (0.095, 0.033, 0.034), 'biceps', ua, arm)
            ell(am['shoulder'] + ua[0] * 0.13 - ua[1] * 0.022, (0.11, 0.033, 0.036), 'triceps', ua, arm)
            arm.append((lambda x, y, z, a=am['elbow'], b=am['wrist']: sd_round_cone(x, y, z, a, b, 0.037, 0.025), None))
            ell(am['elbow'] + fa[0] * 0.07, (0.08, 0.036, 0.036), None, fa, arm)
            hc = am['wrist'] + fa[0] * 0.065
            ell(hc, (0.07, 0.03, 0.04), None, fa, arm)
            self.hands.append(hc)
            self.arms.append(arm)

    @staticmethod
    def blend(parts, x, y, z, k):
        d = None
        for f, _ in parts:
            v = f(x, y, z)
            d = v if d is None else smin(d, v, k)
        return d

    def sdf(self, x, y, z):
        t = self.blend(self.torso, x, y, z, 0.03)
        legs = np.minimum(*(self.blend(l, x, y, z, 0.022) for l in self.legs))
        body = smin(t, legs, 0.025)
        for a in self.arms:
            body = np.minimum(body, self.blend(a, x, y, z, 0.02))
        return body

    def muscle_weight(self, x, y, z, targets):
        w = np.zeros_like(x)
        for group in [self.torso] + self.legs + self.arms:
            for f, tag in group:
                if tag in targets:
                    w = np.maximum(w, np.clip((0.03 - f(x, y, z)) / 0.025, 0, 1))
        return w


# ---------- props ----------


def chair_parts(seat_top, x0, x1):
    """A plain chair whose seat runs from x0 (back) to x1 (front)."""
    parts = []
    parts.append(lambda x, y, z: sd_box(x, y, z, ((x0 + x1) / 2, seat_top - 0.025, 0), ((x1 - x0) / 2, 0.025, 0.23), 0.01))
    parts.append(lambda x, y, z: sd_box(x, y, z, (x0 + 0.02, seat_top + 0.25, 0), (0.02, 0.22, 0.23), 0.01))
    for lx in (x0 + 0.03, x1 - 0.03):
        for lz in (-0.2, 0.2):
            parts.append(lambda x, y, z, lx=lx, lz=lz: sd_box(x, y, z, (lx, (seat_top - 0.05) / 2, lz), (0.018, (seat_top - 0.05) / 2, 0.018)))
    return parts


def dumbbell_parts(hands):
    parts = []
    for h in hands:
        parts.append(lambda x, y, z, h=h: sd_cyl_z(x, y, z, h, 0.016, 0.075))
        for s in (-1, 1):
            parts.append(lambda x, y, z, h=h, s=s: sd_cyl_z(x, y, z, (h[0], h[1], h[2] + s * 0.075), 0.048, 0.022))
    return parts


# ---------- solving poses ----------


def solve(pose, key, err, lo, hi, steps=40):
    """Finds a value between lo and hi that makes err(skeleton) zero (bisection), and
    returns the pose with it set. key is a pose key, or a function (pose, value) that
    sets one or more keys."""
    setter = key if callable(key) else (lambda p, v: p.__setitem__(key, v))

    def f(v):
        p = dict(pose)
        setter(p, v)
        return err(skeleton(p))
    a, b = lo, hi
    fa = f(a)
    for _ in range(steps):
        m = (a + b) / 2
        fm = f(m)
        if (fm > 0) == (fa > 0):
            a, fa = m, fm
        else:
            b = m
    p = dict(pose)
    setter(p, (a + b) / 2)
    return p


def shoulder_y(j):
    return j['shoulder'][1]


# ---------- exercises ----------
# keys: the poses to ease between. Optional: setup() returns (keys, props); fix(pose)
# adjusts each in-between pose; air(u) lifts the figure; hold and ms set the timing;
# az and el place the camera (degrees round from the side, and up).

STAND = dict(toe=(0.16, 0.026), foot=71, shin=180, thigh=180, torso=180, upper=6, fore=10)
FREE = dict(hip=(0.0, 1.0), torso=180, hip_k=0, knee_a=0, foot=71, upper=6, fore=10, ground=['toe', 'heel'])


def wall_setup():
    lean_out = dict(toe=(0.0, 0.03), foot=58, shin=158, thigh=158, torso=158)
    j = skeleton(dict(lean_out, upper=90, fore=90))
    wall_x = j['shoulder'][0] + 0.50
    hand = (wall_x - 0.115, j['shoulder'][1] - 0.04)  # palm flat on the wall
    keys = [dict(lean_out, hand=hand, arm_z=(SHOULDER_Z, 0.27, 0.24)),
            dict(lean_out, shin=147, thigh=147, torso=147, hand=hand, arm_z=(SHOULDER_Z, 0.27, 0.24))]
    props = [(lambda x, y, z: sd_box(x, y, z, (wall_x + 0.03, 0.95, 0), (0.03, 0.95, 0.36), 0.01), PANEL)]
    return keys, props


def heel_setup():
    j = skeleton(STAND)
    bar_x = j['shoulder'][0] + 0.42
    bar_y = 0.98
    hand = (bar_x - 0.06, bar_y + 0.02)
    keys = [dict(STAND, hand=hand), dict(STAND, foot=38, hand=hand)]
    props = [(lambda x, y, z: sd_box(x, y, z, (bar_x, bar_y - 0.03, 0), (0.03, 0.025, 0.3), 0.01), PROP)]
    for lz in (-0.27, 0.27):
        props.append((lambda x, y, z, lz=lz: sd_box(x, y, z, (bar_x, bar_y / 2, lz), (0.018, bar_y / 2, 0.018)), PROP))
    return keys, props


def sit_setup():
    sit = dict(toe=(0.16, 0.026), foot=71, shin=180, thigh=270, torso=170, upper=40, fore=75)
    j = skeleton(sit)
    seat_top = j['hip'][1] - 0.08
    props = [(p, PROP) for p in chair_parts(seat_top, j['hip'][0] - 0.24, j['hip'][0] + 0.2)]
    keys = [sit,
            dict(sit, shin=166, thigh=240, torso=135, upper=80, fore=84),
            dict(STAND, upper=80, fore=84),
            dict(STAND, upper=10, fore=12)]
    return keys, props


# Push-up: the body pivots on the toes, the hands stay planted under the shoulders.
def pushup_setup():
    top = dict(toe=(0.0, 0.026), foot=22, shin=111, thigh=111, torso=111, head=-8)
    hx = skeleton(dict(top, upper=0, fore=0))['shoulder'][0] + 0.03
    hand = (hx, 0.10)
    az = (SHOULDER_Z, 0.29, 0.25)
    return [dict(top, hand=hand, arm_z=az), dict(top, shin=99, thigh=99, torso=99, hand=hand, elbow_down=True, arm_z=az)], []


# Forearm plank: the body angle is solved so the elbows rest on the floor.
def plank_fix(p):
    lift = p.get('lift', 0)
    p = dict(p, upper=0, fore=90)

    def body(q, v):
        q['shin'], q['thigh'], q['torso'] = v, v - lift, v + lift
    return solve(p, body, lambda j: shoulder_y(j) - (L['upper'] + 0.05), 92, 130)


# Lying on the back, knees bent: the thigh angle is solved so the hips (crunch) rest on
# the floor, and the torso so the shoulders rest on it (bridge).
def lying_fix(hip_on_floor, crunch):
    def fix(p):
        if hip_on_floor:
            p = solve(p, 'thigh', hip_err, 271, 359)
        if not crunch:
            j = skeleton(dict(p, torso=270))
            c = np.clip((j['hip'][1] - 0.13) / (L['torso'] - 0.035), -1, 1)
            p['torso'] = 360 - math.degrees(math.acos(c))
            p['head'] = 268 - p['torso']
            p['upper'], p['fore'] = 86, 88
        else:
            p['head'] = (272 - p['torso']) * 0.4
            p['upper'] = p['fore'] = p['torso'] - 192
        return p
    return fix


# Lunge: the back shin is solved so the back toes rest on the floor.
def lunge_fix(p):
    return solve(p, 'knee_a_f', lambda j: j['legs'][-1]['toe'][1] - CONTACT['toe'], 270, 359)


def hip_err(j):
    return j['hip'][1] - 0.12


def jump(height, start=0.5):
    def air(u):
        t = max(0.0, (u - start) / (1 - start))
        return height * math.sin(math.pi * t / 2) ** 2 if start else height * math.sin(math.pi * u)
    return air


LUNGE_TOP = dict(FREE, hip_k_n=14, knee_a_n=354, foot_n=71, hip_k_f=348, knee_a_f=330, foot_f=22,
                 ground=['toe_n', 'heel_n'], upper=4, fore=8)
LUNGE_LOW = dict(LUNGE_TOP, hip_k_n=80, knee_a_n=2, hip_k_f=355, knee_a_f=300, foot_f=12)

BRIDGE = dict(toe=(0.42, 0.026), foot=88, shin=212, thigh=300, torso=280)
BRIDGE = solve(BRIDGE, 'thigh', lambda j: j['hip'][1] - 0.12, 271, 359)  # hips resting on the floor
CRUNCH = dict(toe=(0.42, 0.026), foot=88, shin=212, thigh=300, torso=272)

HIGH_PLANK = dict(hip=(0.0, 0.6), shoulder_y=0.62, torso=100, hand_floor=0.02, head=-10, foot=22,
                  ground=['toe'])
# Near knee driven in, far leg straight back with its toes on the floor.
CLIMB_N = dict(HIGH_PLANK, hip_k_n=66, knee_a_n=290, foot_n=30, hip_k_f=300, knee_a_f=300, foot_f=22,
               ground=['toe_f'])
# The hips stay at one height while the legs swap.
CLIMB_N['hip'] = (0.0, float(skeleton(CLIMB_N)['hip'][1]))
CLIMB_N['ground'] = None
CLIMB_F = dict(CLIMB_N, hip_k_f=66, knee_a_f=290, foot_f=30, hip_k_n=300, knee_a_n=300, foot_n=22)

KNEEL = dict(hip=(0.0, 0.6), torso=90, shoulder_y=0.60, hip_k=0, knee_a=272, foot=272, ground=['knee'],
             hand_floor_f=0.0, upper_n=0, fore_n=0, head=-15)
BIRD = dict(KNEEL, hip_k_f=268, knee_a_f=268, foot_f=275, upper_n=98, fore_n=98, head=-5)

KNEES_N = dict(FREE, hip_k_n=92, knee_a_n=2, foot_n=50, upper_n=330, fore_n=60, upper_f=40, fore_f=150, ground=['toe', 'heel'])
KNEES_F = dict(FREE, hip_k_f=92, knee_a_f=2, foot_f=50, upper_f=330, fore_f=60, upper_n=40, fore_n=150, ground=['toe', 'heel'])
KNEES_MID = dict(FREE, hip_k=8, knee_a=350, foot=60, upper=5, fore=95, ground=['toe', 'heel'])

JACK_IN = dict(FREE, leg_out=3, arm_out=8, upper=0, fore=0)
JACK_OUT = dict(FREE, leg_out=17, arm_out=168, upper=0, fore=0)

SQUAT_LOW = dict(STAND, shin=138, thigh=250, torso=136, upper=84, fore=86)

EXERCISES = {
    # ---- the original physiotherapy set ----
    'sit_to_stand': dict(setup=sit_setup, muscles={'quads', 'glutes'}, az=28),
    'mini_squat': dict(muscles={'quads', 'glutes', 'hamstrings'}, az=28, keys=[
        dict(STAND, upper=10, fore=12),
        dict(STAND, shin=155, thigh=215, torso=152, upper=80, fore=82)]),
    'wall_pushup': dict(setup=wall_setup, muscles={'chest', 'triceps'}, az=10),
    'bicep_curl': dict(muscles={'biceps'}, az=40, dumbbells=True, keys=[
        dict(STAND, upper=4, fore=8), dict(STAND, upper=10, fore=150)]),
    'arm_raise': dict(muscles={'shoulders'}, az=40, dumbbells=True, keys=[
        dict(STAND, upper=6, fore=8), dict(STAND, upper=88, fore=90)]),
    'heel_raise': dict(setup=heel_setup, muscles={'calves'}, az=-38),

    # ---- strength ----
    'squat': dict(muscles={'quads', 'glutes', 'hamstrings'}, az=30, keys=[dict(STAND, upper=10, fore=12), SQUAT_LOW]),
    'lunge': dict(muscles={'quads', 'glutes'}, az=22, fix=lunge_fix, keys=[LUNGE_TOP, LUNGE_LOW]),
    'push_up': dict(setup=pushup_setup, muscles={'chest', 'triceps', 'shoulders'}, az=24, el=14),
    'romanian_deadlift': dict(muscles={'hamstrings', 'glutes', 'lower_back'}, az=30, dumbbells=True, keys=[
        dict(STAND, upper=0, fore=0),
        dict(STAND, shin=172, thigh=202, torso=104, head=-20, upper=0, fore=0)]),
    'bent_over_row': dict(muscles={'lats', 'biceps'}, az=32, dumbbells=True, keys=[
        dict(STAND, shin=168, thigh=204, torso=118, head=-18, upper=0, fore=0),
        dict(STAND, shin=168, thigh=204, torso=118, head=-18, upper=262, fore=4)]),
    'shoulder_press': dict(muscles={'shoulders', 'triceps'}, az=40, dumbbells=True, keys=[
        dict(STAND, upper=32, fore=172, arm_z=(SHOULDER_Z, 0.30, 0.27)),
        dict(STAND, upper=172, fore=176, arm_z=(SHOULDER_Z, 0.24, 0.20))]),
    'tricep_extension': dict(muscles={'triceps'}, az=34, dumbbells=True, keys=[
        dict(STAND, upper=172, fore=176, arm_z=(SHOULDER_Z, 0.17, 0.15)),
        dict(STAND, upper=168, fore=338, arm_z=(SHOULDER_Z, 0.17, 0.15))]),
    'glute_bridge': dict(muscles={'glutes', 'hamstrings'}, az=26, el=16, fix=lying_fix(False, False), keys=[
        BRIDGE, dict(BRIDGE, thigh=270)]),
    'superman': dict(muscles={'lower_back', 'glutes'}, az=30, el=16, keys=[
        dict(hip=(0.0, 0.125), torso=90, head=0, hip_k=272, knee_a=272, foot=300, upper=92, fore=92),
        dict(hip=(0.0, 0.125), torso=76, head=-8, hip_k=258, knee_a=259, foot=285, upper=106, fore=106)]),

    # ---- core ----
    'plank': dict(muscles={'abs'}, az=26, el=14, fix=plank_fix, keys=[
        dict(toe=(0.0, 0.026), foot=22, shin=105, thigh=105, torso=105, lift=0, head=-8),
        dict(toe=(0.0, 0.026), foot=22, shin=105, thigh=105, torso=105, lift=3, head=-14)]),
    'crunch': dict(muscles={'abs'}, az=26, el=16, fix=lying_fix(True, True), keys=[
        CRUNCH, dict(CRUNCH, torso=238)]),
    'bird_dog': dict(muscles={'abs', 'lower_back', 'glutes'}, az=30, el=14, keys=[KNEEL, BIRD]),

    # ---- cardio ----
    'jumping_jacks': dict(muscles={'calves', 'shoulders', 'glutes'}, az=68, hold=0, ms=40, air=jump(0.06, 0),
                          keys=[JACK_IN, JACK_OUT]),
    'high_knees': dict(muscles={'quads', 'calves'}, az=32, hold=0, ms=32, air=lambda u: 0.04 * abs(math.sin(2 * math.pi * u)), keys=[KNEES_N, KNEES_MID, KNEES_F]),
    'mountain_climbers': dict(muscles={'abs', 'quads', 'shoulders'}, az=28, el=14, hold=0, ms=32,
                              keys=[CLIMB_N, CLIMB_F]),
    'jump_squat': dict(muscles={'quads', 'glutes', 'calves'}, az=30, hold=1, air=jump(0.16, 0.55),
                       keys=[dict(SQUAT_LOW, foot=71), dict(STAND, upper=176, fore=178, foot=50)]),
}


def pose_at(keys, u):
    n = len(keys) - 1
    xq = u * n
    i = min(int(xq), n - 1)
    t = ease(xq - i)
    a, b = keys[i], keys[i + 1]
    out = {}
    def look(pose, k):
        # a side-only key missing from one pose falls back to that pose's shared value
        if k in pose:
            return pose[k]
        if k[-2:] in ('_n', '_f'):
            return pose.get(k[:-2])
        return None

    for k in set(a) | set(b):
        v, w = look(a, k), look(b, k)
        if v is None or w is None:
            out[k] = v if w is None else w
        elif isinstance(v, tuple):
            out[k] = tuple(lerp(p, q, t) for p, q in zip(v, w))
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            # angles turn the shorter way round (354 to 2 passes through 0, not 180)
            if abs(w - v) > 180:
                w += 360 if w < v else -360
            out[k] = lerp(v, w, t)
        else:
            out[k] = v if t < 0.5 else w
    return out


def frame_u(f, hold):
    half = FRAMES // 2
    span = half - 2 * hold
    if f < half:
        return min(1.0, max(0.0, (f - hold) / span))
    return 1 - min(1.0, max(0.0, (f - half - hold) / span))


# ---------- camera and rendering ----------


class Camera:
    def __init__(self, az, el, points):
        a, e = math.radians(az), math.radians(el)
        self.vd = np.array([math.sin(a) * math.cos(e), math.sin(e), math.cos(a) * math.cos(e)], np.float32)
        f = -self.vd
        r = np.cross(f, [0, 1, 0])
        self.r = (r / np.linalg.norm(r)).astype(np.float32)
        self.u = np.cross(self.r, f).astype(np.float32)
        sx, sy = points @ self.r, points @ self.u
        cx, cy = (sx.min() + sx.max()) / 2, (sy.min() + sy.max()) / 2
        half = max(sx.max() - sx.min(), sy.max() - sy.min()) / 2 * 1.1
        self.cx, self.cy, self.half = cx, cy, half

    def rays(self, res):
        g = (np.arange(res, dtype=np.float32) + 0.5) / res * 2 - 1
        sx = self.cx + g[None, :] * self.half
        sy = self.cy - g[:, None] * self.half
        sx, sy = np.broadcast_to(sx, (res, res)).ravel(), np.broadcast_to(sy, (res, res)).ravel()
        o = sx[:, None] * self.r + sy[:, None] * self.u + self.vd * 6.0
        return o.astype(np.float32), -self.vd


def render(scene, cam, targets, res):
    fig, props = scene

    def sdf(x, y, z):
        d = fig.sdf(x, y, z)
        for f, _ in props:
            d = np.minimum(d, f(x, y, z))
        return d

    o, rd = cam.rays(res)
    n = o.shape[0]
    img = np.ones((n, 3), np.float32)

    # Floor at y = 0: where each ray meets it.
    t_floor = np.where(rd[1] < 0, o[:, 1] / -rd[1], 1e9).astype(np.float32)

    idx = np.arange(n)
    t = np.full(idx.size, 4.0, np.float32)  # rays start 6 m out; nothing is closer than 4 m
    hit = np.zeros(idx.size, bool)
    alive = np.ones(idx.size, bool)
    oo = o[idx]
    tf = t_floor[idx]
    for _ in range(140):
        a = np.nonzero(alive)[0]
        if a.size == 0:
            break
        p = oo[a] + t[a, None] * rd
        d = sdf(p[:, 0], p[:, 1], p[:, 2])
        t[a] += d
        done = d < 0.0008
        hit[a[done]] = True
        gone = t[a] > np.minimum(tf[a], 16.0)
        alive[a[done | gone]] = False

    # Shade surface hits.
    hi_i = np.nonzero(hit & (t < tf))[0]
    if hi_i.size:
        p = oo[hi_i] + t[hi_i, None] * rd
        x, y, z = p[:, 0], p[:, 1], p[:, 2]
        e = 0.0007
        k = np.array([[1, -1, -1], [-1, -1, 1], [-1, 1, -1], [1, 1, 1]], np.float32)
        nrm = sum(k[i] * sdf(x + k[i, 0] * e, y + k[i, 1] * e, z + k[i, 2] * e)[:, None] for i in range(4))
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9

        # material: body (grey, red where a target muscle is) or a prop
        dbody = fig.sdf(x, y, z)
        col = np.tile(BODY, (hi_i.size, 1))
        w = fig.muscle_weight(x, y, z, targets)[:, None]
        col = col * (1 - w) + MUSCLE * w
        for f, c in props:
            m = f(x, y, z) < dbody
            col[m] = c

        ao = np.ones(hi_i.size, np.float32)
        for i, hgt in enumerate((0.015, 0.035, 0.07, 0.12)):
            dd = sdf(x + nrm[:, 0] * hgt, y + nrm[:, 1] * hgt, z + nrm[:, 2] * hgt)
            ao -= (hgt - dd) * (2.2 / (i + 1))
        ao = np.clip(ao, 0, 1)

        l1 = -0.35 * cam.r + 0.75 * cam.u + 0.6 * cam.vd
        l1 /= np.linalg.norm(l1)
        l2 = 0.7 * cam.r + 0.1 * cam.u + 0.55 * cam.vd
        l2 /= np.linalg.norm(l2)
        dif1 = np.clip(nrm @ l1, 0, 1)
        dif2 = np.clip(nrm @ l2, 0, 1)
        hemi = 0.5 + 0.5 * nrm[:, 1]
        ref = rd - 2 * (nrm @ rd)[:, None] * nrm
        spec = np.clip(ref @ l1, 0, 1) ** 24
        rim = (1 - np.clip(nrm @ cam.vd, 0, 1)) ** 3
        light = 0.40 * hemi * ao + 0.62 * dif1 * (0.6 + 0.4 * ao) + 0.24 * dif2 * ao
        shade = col * light[:, None] + (0.10 * spec * ao + 0.07 * rim * ao)[:, None]
        img[idx[hi_i]] = np.clip(shade * 1.12, 0, 1)

    # Floor: white with a soft shadow and contact darkening near the body.
    fl = idx[~(hit & (t < tf)) & (tf < 1e8)]
    if fl.size:
        p = o[fl] + t_floor[fl, None] * rd
        x, z = p[:, 0], p[:, 2]
        ls = np.array([0.12, 1.0, 0.22], np.float32)
        ls /= np.linalg.norm(ls)
        sh = np.ones(fl.size, np.float32)
        st = np.full(fl.size, 0.01, np.float32)
        for _ in range(28):
            q = p + st[:, None] * ls
            dd = sdf(q[:, 0], q[:, 1], q[:, 2])
            sh = np.minimum(sh, 6.0 * dd / st)
            st += np.clip(dd, 0.01, 0.15)
        sh = np.clip(sh, 0, 1)
        dd = sdf(x, np.full_like(x, 0.04), z)
        contact = np.clip(dd / 0.04, 0, 1)
        v = 1 - 0.16 * (1 - sh) - 0.12 * (1 - contact)
        img[fl] = v[:, None]

    return img.reshape(res, res, 3)


def joint_points(fig):
    """Every 3D point the figure's parts were built from, for framing the camera."""
    pts = []
    for group in [fig.torso] + fig.legs + fig.arms:
        for f, _ in group:
            for d in f.__defaults__ or ():
                if isinstance(d, np.ndarray) and d.shape == (3,):
                    pts.append(d)
    return np.array(pts)


def build(code):
    spec = EXERCISES[code]
    if 'setup' in spec:
        keys, props = spec['setup']()
    else:
        keys, props = spec['keys'], []
    hold = spec.get('hold', HOLD)
    poses = []
    for f in range(FRAMES):
        u = frame_u(f, hold)
        p = pose_at(keys, u)
        if spec.get('air'):
            p['air'] = spec['air'](u)
        if spec.get('fix'):
            p = spec['fix'](p)
        poses.append(p)
    figs = [Figure(skeleton(p)) for p in poses]
    return spec, props, figs


def framing(spec, figs):
    pts = []
    for fig in figs:
        p = joint_points(fig)
        lo, hi = p.min(0) - 0.1, p.max(0) + 0.1
        pts += [[x, y, z] for x in (lo[0], hi[0]) for y in (0.0, hi[1]) for z in (-0.3, 0.3)]
    return Camera(spec['az'], spec.get('el', 9), np.array(pts, np.float32))


def render_frame(args):
    code, f, out, ss = args
    spec, props, figs = build(code)
    fig = figs[f]
    if spec.get('dumbbells'):
        props = props + [(p, PROP) for p in dumbbell_parts(fig.hands)]
    cam = framing(spec, figs)
    img = render((fig, props), cam, spec['muscles'], out * ss)
    im = Image.fromarray((img * 255 + 0.5).astype(np.uint8))
    return Image.fromarray(snap_white(np.asarray(im.resize((out, out), Image.LANCZOS))))


def snap_white(a):
    """Makes the background pure white, so it matches the white cards it sits on."""
    a = a.copy()
    a[a.min(axis=2) >= 246] = 255
    return a


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    site = os.path.join(here, '..')
    folder = os.path.join(site, 'img', 'exercises')
    os.makedirs(folder, exist_ok=True)
    args = sys.argv[1:]
    preview = '--preview' in args
    codes = [a for a in args if not a.startswith('--')] or list(EXERCISES)
    with Pool() as pool:
        if preview:
            picks = [0, FRAMES // 4, FRAMES // 2 - 1, 3 * FRAMES // 4]
            jobs = [(c, f, 200, 1) for c in codes for f in picks]
            ims = pool.map(render_frame, jobs)
            for i, code in enumerate(codes):
                sheet = Image.new('RGB', (800, 200), 'white')
                for k in range(4):
                    sheet.paste(ims[i * 4 + k], (k * 200, 0))
                sheet.save(os.path.join(site, 'img', f'_preview_{code}.png'))
                print('preview', code, flush=True)
            return
        for code in codes:
            frames = pool.map(render_frame, [(code, f, OUT, SS) for f in range(FRAMES)])
            # one palette for every frame, so colours don't flicker
            sheet = Image.new('RGB', (OUT * 8, OUT))
            for i in range(8):
                sheet.paste(frames[i * FRAMES // 8], (i * OUT, 0))
            pal = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
            out = [fr.quantize(palette=pal, dither=Image.Dither.NONE) for fr in frames]
            path = os.path.join(folder, code + '.gif')
            ms = EXERCISES[code].get('ms', FRAME_MS)
            out[0].save(path, save_all=True, append_images=out[1:], duration=ms, loop=0, optimize=False)
            print('wrote', os.path.relpath(path, site), flush=True)


if __name__ == '__main__':
    main()
