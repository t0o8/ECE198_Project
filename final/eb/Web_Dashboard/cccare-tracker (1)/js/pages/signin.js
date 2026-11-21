/* Sign-in page. Existing users sign in with their username and password; the account
   decides whether they go to the instructor or patient pages. First-time users press
   Sign up, pick a username and password, and choose instructor or patient. */
CC.start(function () {
  'use strict';
  const { h } = CC.util;
  const signin = document.getElementById('signin');
  const signup = document.getElementById('signup');
  const error = document.getElementById('error');
  const signupError = document.getElementById('signup-error');
  const title = document.getElementById('page-title');
  const switchText = document.getElementById('switch-text');
  const switchBtn = document.getElementById('switch-btn');

  function show(mode) {
    const up = mode === 'signup';
    signin.hidden = up;
    signup.hidden = !up;
    // The form that appears slides in (restarting the animation each time).
    const shown = up ? signup : signin;
    shown.classList.remove('form-in');
    void shown.offsetWidth;
    shown.classList.add('form-in');
    title.textContent = up ? 'Sign up' : 'Sign in';
    document.title = `${up ? 'Sign up' : 'Sign in'} · CCCARE exercise tracking`;
    switchText.textContent = up ? 'Already have an account?' : 'First time here?';
    switchBtn.textContent = up ? 'Sign in' : 'Sign up';
    error.textContent = '';
    signupError.textContent = '';
    (up ? signup : signin).elements.username.focus();
  }
  switchBtn.addEventListener('click', () => show(signup.hidden ? 'signup' : 'signin'));
  if (location.hash === '#signup') show('signup');

  const current = CC.auth.current();
  if (current) {
    const note = document.getElementById('already');
    note.hidden = false;
    note.replaceChildren(
      `Signed in as ${current.username}. `,
      h('a', { href: CC.auth.home(current) }, 'Continue'),
      ', or sign in with another account.');
  }

  // Disables a form's button while the server answers, so it isn't sent twice.
  function busy(form, on) {
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = on;
    btn.setAttribute('aria-busy', String(on));
  }

  signin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = signin.elements.username.value;
    const password = signin.elements.password.value;
    if (!username.trim() || !password) {
      error.textContent = 'Enter your username and password.';
      return;
    }
    busy(signin, true);
    const outcome = await CC.auth.signIn(username, password);
    busy(signin, false);
    if (outcome.account) {
      CC.go(CC.auth.home(outcome.account));
      return;
    }
    error.textContent = outcome.error;
    signin.elements.password.value = '';
    signin.elements.password.focus();
  });

  signup.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = signup.elements;
    const role = f.role.value;
    let problem = '';
    if (!f.username.value.trim() || !f.password.value) problem = 'Choose a username and password.';
    else if (f.password.value !== f.confirm.value) problem = 'The two passwords don’t match.';
    else if (!role) problem = 'Choose whether this account is for an instructor or a patient.';
    if (!problem) {
      busy(signup, true);
      const outcome = await CC.auth.signUp(f.username.value, f.password.value, role);
      busy(signup, false);
      if (outcome.account) {
        CC.go(CC.auth.home(outcome.account));
        return;
      }
      problem = outcome.error;
    }
    signupError.textContent = problem;
  });
}, { load: false });
