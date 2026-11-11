/* Profile for whoever is signed in: a picture, a nickname, a birthday and a short biography.
   The picture comes from a file (the paperclip) or the camera (the browser asks for
   permission first). Either way it's cropped to a square and shrunk to 256 pixels before
   it's saved, so it's small enough to store. */
CC.start(function () {
  'use strict';
  const account = CC.auth.require();
  if (!account) return;

  const { fill, fmtDate } = CC.util;
  CC.ui.frame(account);

  const home = CC.auth.home(account);
  document.getElementById('home').href = home;
  document.getElementById('back').href = home;

  const form = document.getElementById('profile');
  const error = document.getElementById('error');
  const saved = document.getElementById('saved');
  const bioCount = document.getElementById('bio-count');
  const PHOTO_PX = 256;
  const FILE_MAX = 15 * 1024 * 1024; // larger files are refused before they're opened

  let profile = CC.profiles.get(account.username);
  let photo = profile.photo;

  const today = new Date();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  form.elements.birthday.max = iso(today);
  form.elements.birthday.min = '1900-01-01';
  form.elements.birthday.value = profile.birthday;
  form.elements.bio.value = profile.bio;
  form.elements.nickname.value = profile.nickname;

  function age(birthday) {
    const [y, m, d] = birthday.split('-').map(Number);
    let years = today.getFullYear() - y;
    if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) years -= 1;
    return years;
  }

  // The card at the top shows the profile as others would see it, including unsaved edits.
  function renderCard() {
    const birthday = form.elements.birthday.value;
    const bio = form.elements.bio.value.trim();
    const nickname = form.elements.nickname.value.replace(/\s+/g, ' ').trim();
    // Shows the picture with its outline as it will look, while the nickname is typed.
    fill(document.getElementById('card-photo'), CC.ui.avatar(account.username, photo, 128, { nickname }));
    document.getElementById('card-name').textContent = nickname || account.username;
    const meta = nickname ? ['@' + account.username, account.role] : [account.role];
    if (account.participantId) meta.push('block ' + CC.slotNumber(account.participantId));
    if (birthday) meta.push(`born ${fmtDate(birthday + 'T12:00:00')} (age ${age(birthday)})`);
    document.getElementById('card-meta').textContent = meta.join(' · ');
    const bioEl = document.getElementById('card-bio');
    bioEl.textContent = bio || 'No biography yet.';
    bioEl.classList.toggle('muted', !bio);
    bioCount.textContent = `${form.elements.bio.value.length} of ${CC.profiles.BIO_MAX} characters`;
    document.getElementById('remove-photo').disabled = !photo;
  }

  function changed() {
    saved.textContent = '';
    error.textContent = '';
    renderCard();
  }
  form.elements.bio.addEventListener('input', changed);
  form.elements.nickname.addEventListener('input', changed);
  form.elements.birthday.addEventListener('change', changed);

  // Center-crops an image (or a video frame) to a square and redraws it at PHOTO_PX as a
  // JPEG. mirror flips it left to right, to match a mirrored camera preview.
  function square(source, width, height, mirror) {
    const side = Math.min(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PHOTO_PX;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, PHOTO_PX, PHOTO_PX);
    if (mirror) {
      ctx.translate(PHOTO_PX, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(source, (width - side) / 2, (height - side) / 2, side, side, 0, 0, PHOTO_PX, PHOTO_PX);
    return canvas.toDataURL('image/jpeg', 0.85);
  }

  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(square(img, img.naturalWidth, img.naturalHeight, false));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('not an image'));
      };
      img.src = url;
    });
  }

  form.elements.photo.addEventListener('change', async () => {
    const file = form.elements.photo.files[0];
    error.textContent = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
      error.textContent = 'Choose a PNG, JPEG, WebP or GIF picture.';
      return;
    }
    if (file.size > FILE_MAX) {
      error.textContent = 'That picture is too large. Choose one under 15 MB.';
      return;
    }
    try {
      photo = await shrink(file);
      hint.textContent = file.name;
      closeCamera();
      changed();
    } catch (e) {
      error.textContent = 'That file couldn’t be opened as a picture.';
    }
  });

  // ---------- camera ----------

  const hint = document.getElementById('photo-hint');
  const takeBtn = document.getElementById('take-photo');
  const camBox = document.getElementById('camera');
  const video = document.getElementById('camera-video');
  const captureBtn = document.getElementById('capture');
  let stream = null;

  // Why the camera couldn't start, in words.
  function cameraProblem(e) {
    switch (e && e.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Camera access was blocked. To take a picture, allow the camera for this site (usually from the icon in the address bar), or choose a file with the paperclip.';
      case 'NotFoundError':
      case 'OverconstrainedError':
        return 'No camera was found. Choose a file with the paperclip instead.';
      case 'NotReadableError':
        return 'The camera is being used by another app. Close it and try again.';
      default:
        return 'The camera couldn’t be started. Choose a file with the paperclip instead.';
    }
  }

  async function openCamera() {
    error.textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      error.textContent = window.isSecureContext
        ? 'This browser can’t use a camera. Choose a file with the paperclip instead.'
        : 'The camera only works on a secure (https://) page or on localhost. Choose a file with the paperclip instead.';
      return;
    }
    takeBtn.disabled = true;
    hint.textContent = 'Allow camera access when your browser asks…';
    try {
      // This is where the browser asks for permission.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      takeBtn.disabled = false;
      hint.textContent = 'Choose a file or take a picture';
      error.textContent = cameraProblem(e);
      return;
    }
    video.srcObject = stream;
    camBox.hidden = false;
    hint.textContent = 'Camera on';
    captureBtn.disabled = true; // until the first frame arrives
    try {
      await video.play();
    } catch (e) {
      /* autoplay is muted, so this rarely fails; the frame check below still works */
    }
    if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
    captureBtn.disabled = false;
    captureBtn.focus();
  }

  function closeCamera() {
    if (stream) stream.getTracks().forEach((t) => t.stop()); // turns the camera light off
    stream = null;
    video.srcObject = null;
    if (!camBox.hidden) {
      camBox.hidden = true;
      takeBtn.disabled = false;
      if (hint.textContent === 'Camera on') hint.textContent = 'Choose a file or take a picture';
    }
  }

  takeBtn.addEventListener('click', openCamera);
  captureBtn.addEventListener('click', () => {
    if (!video.videoWidth) return;
    // The preview is mirrored like a mirror, so the picture is too: what you see is what you get.
    photo = square(video, video.videoWidth, video.videoHeight, true);
    closeCamera();
    hint.textContent = 'Picture taken';
    changed();
    takeBtn.focus();
  });
  document.getElementById('camera-cancel').addEventListener('click', () => {
    closeCamera();
    takeBtn.focus();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && stream) {
      closeCamera();
      takeBtn.focus();
    }
  });
  // Never leave the camera on after leaving the page.
  window.addEventListener('pagehide', closeCamera);

  document.getElementById('remove-photo').addEventListener('click', () => {
    photo = '';
    form.elements.photo.value = '';
    hint.textContent = 'Choose a file or take a picture';
    changed();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    error.textContent = '';
    const birthday = form.elements.birthday.value;
    if (birthday && (birthday > iso(today) || birthday < '1900-01-01')) {
      error.textContent = 'Enter a birthday between 1900 and today.';
      return;
    }
    const next = { nickname: form.elements.nickname.value, bio: form.elements.bio.value.trim(), birthday, photo };
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    saved.textContent = 'Saving…';
    try {
      await CC.profiles.save(account.username, next);
    } catch (err) {
      saved.textContent = '';
      error.textContent = err.message;
      return;
    } finally {
      btn.disabled = false;
    }
    profile = CC.profiles.get(account.username);
    saved.textContent = 'Saved.';
    // Updates the picture and name in the header.
    document.querySelectorAll('.profile-link .avatar').forEach((el) =>
      el.replaceWith(CC.ui.avatar(CC.profiles.nameFor(account), profile.photo, 24, { nickname: profile.nickname })));
    document.querySelectorAll('[data-who]').forEach((el) => (el.textContent = `${account.role} · ${CC.profiles.nameFor(account)}`));
  });

  renderCard();
});
