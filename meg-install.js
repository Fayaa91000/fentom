
/* MEG install invitation.
   Independent of checkout and customer login. */
(() => {
  'use strict';

  const script = document.currentScript;
  const siteRoot = new URL(
    './',
    script ? script.src : window.location.href
  );

  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;

  const readDismissed = () => {
    try {
      return sessionStorage.getItem(
        'meg-install-dismissed'
      ) === '1';
    } catch {
      return false;
    }
  };

  // Register our app service worker.
  if (
    window.isSecureContext &&
    'serviceWorker' in navigator
  ) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(
        new URL('meg-sw.js', siteRoot).href,
        { scope: siteRoot.pathname }
      ).catch(err => {
        console.warn(
          'MEG installation worker unavailable:',
          err
        );
      });
    }, { once: true });
  }

  if (isStandalone || readDismissed()) return;

  // Installation invitation styling.
  const css = document.createElement('style');
  css.textContent = `
    .meg-app-bar {
      max-width:1140px;
      margin:14px auto;
      padding:15px 18px;
      display:flex;
      align-items:center;
      gap:14px;
      flex-wrap:wrap;
      background:#e9f7fb;
      border:1px solid #c0e4eb;
      border-radius:16px;
      color:#143c50;
      box-sizing:border-box;
      font:inherit;
    }

    .meg-app-bar strong {color:#06345a}

    .meg-app-bar p {
      margin:3px 0 0;
      font-size:13px;
      line-height:1.5;
    }

    .meg-app-copy {
      flex:1;
      min-width:190px;
    }

    .meg-app-controls {
      display:flex;
      gap:8px;
      flex-wrap:wrap;
      align-items:center;
    }

    .meg-app-btn {
      background:#0874a6!important;
      color:#fff!important;
      border:0!important;
      border-radius:999px!important;
      padding:11px 14px!important;
      font:600 14px/1.2 system-ui,Arial,sans-serif!important;
      cursor:pointer!important;
      min-height:42px;
    }

    .meg-app-ios {
      background:#06345a!important;
    }

    .meg-app-close {
      background:transparent!important;
      color:#345!important;
      border:0!important;
      padding:8px!important;
      font-size:23px!important;
      cursor:pointer!important;
    }

    .meg-app-dialog {
      position:fixed;
      inset:0;
      z-index:20000;
      background:#07243b99;
      display:grid;
      place-items:center;
      padding:20px;
      box-sizing:border-box;
    }

    .meg-app-dialog[hidden] {
      display:none!important;
    }

    .meg-app-dialog-card {
      background:white;
      border-radius:19px;
      padding:22px;
      width:min(100%,410px);
      box-sizing:border-box;
      box-shadow:0 15px 50px #0004;
      color:#18324a;
      font:16px/1.6 system-ui,Arial,sans-serif;
    }

    .meg-app-dialog-card h2 {
      font-size:21px;
      color:#06345a;
      margin:0 0 7px;
    }

    .meg-app-dialog-card p {
      margin:0 0 14px;
    }

    .meg-app-dialog-card button {
      min-height:44px;
    }

    .meg-app-info {
      font-size:12px;
      color:#526e7d;
      margin-top:6px;
    }
  `;
  document.head.append(css);

  // Display installation buttons.
  const bar = document.createElement('section');
  bar.className = 'meg-app-bar';

  bar.setAttribute(
    'aria-label',
    'Install MEG Marketplace'
  );

  bar.innerHTML = `
    <div class="meg-app-copy">
      <strong>📱 MEG Marketplace — app preview</strong>
      <p>
        Install our marketplace on your phone.
        No App Store download needed.
      </p>
    </div>

    <div class="meg-app-controls">
      <button
        class="meg-app-btn"
        type="button"
        data-meg-android
      >🤖 Android app</button>

      <button
        class="meg-app-btn meg-app-ios"
        type="button"
        data-meg-ios
      > iPhone app</button>

      <button
        class="meg-app-close"
        type="button"
        data-meg-close
        aria-label="Dismiss app invitation"
      >×</button>
    </div>
  `;

  const header =
    document.querySelector('body > header') ||
    document.querySelector('header');

  if (header) {
    header.insertAdjacentElement('afterend', bar);
  } else {
    document.body.prepend(bar);
  }

  // Installation instructions dialog.
  const backdrop = document.createElement('div');
  backdrop.className = 'meg-app-dialog';
  backdrop.hidden = true;

  backdrop.innerHTML = `
    <div
      class="meg-app-dialog-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="meg-app-dialog-title"
    >
      <h2 id="meg-app-dialog-title">
        Install MEG Marketplace
      </h2>

      <p id="meg-app-dialog-details"></p>

      <button
        type="button"
        class="meg-app-btn"
        data-meg-dialog-close
      >OK, got it</button>

      <div class="meg-app-info">
        MEG is a website app preview,
        not yet listed on Google Play
        or Apple's App Store.
      </div>
    </div>
  `;

  document.body.append(backdrop);

  const title = backdrop.querySelector(
    '#meg-app-dialog-title'
  );
  const details = backdrop.querySelector(
    '#meg-app-dialog-details'
  );

  let promptEvent = null;

  const hideDialog = () => {
    backdrop.hidden = true;
  };

  const showDialog = (heading, content) => {
    title.textContent = heading;
    details.textContent = content;
    backdrop.hidden = false;

    backdrop.querySelector(
      '[data-meg-dialog-close]'
    ).focus();
  };

  backdrop.querySelector(
    '[data-meg-dialog-close]'
  ).addEventListener('click', hideDialog);

  backdrop.addEventListener('click', event => {
    if (event.target === backdrop) hideDialog();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideDialog();
  });

  bar.querySelector(
    '[data-meg-close]'
  ).addEventListener('click', () => {
    bar.remove();

    try {
      sessionStorage.setItem(
        'meg-install-dismissed',
        '1'
      );
    } catch {}
  });

  // Android install prompt.
  window.addEventListener(
    'beforeinstallprompt',
    event => {
      event.preventDefault();
      promptEvent = event;
    }
  );

  window.addEventListener('appinstalled', () => {
    promptEvent = null;
    bar.remove();
    hideDialog();
  });

  bar.querySelector(
    '[data-meg-android]'
  ).addEventListener('click', async () => {

    if (promptEvent) {
      const event = promptEvent;
      promptEvent = null;

      try {
        await event.prompt();
        const answer = await event.userChoice;

        if (answer?.outcome === 'accepted') {
          bar.remove();
        }
      } catch (err) {
        console.warn(
          'MEG installation prompt unavailable:',
          err
        );

        showDialog(
          'Install on Android',
          'In Chrome, open the three-dot menu ' +
          '(⋮) and choose Install app or ' +
          'Add to Home screen. If you only see ' +
          'Add to Home screen, that may create ' +
          'a shortcut instead of a standalone app.'
        );
      }

    } else {
      showDialog(
        'Install on Android',
        'Open MEG in Chrome, tap the three-dot ' +
        'menu (⋮), then choose Install app ' +
        'or Add to Home screen. Installation ' +
        'depends on your browser and device.'
      );
    }
  });

  // iPhone installation instructions.
  bar.querySelector(
    '[data-meg-ios]'
  ).addEventListener('click', () => {
    showDialog(
      'Install on iPhone',
      'Open MEG in Safari, tap Share ' +
      '(square with an upward arrow), ' +
      'select Add to Home Screen, ' +
      'choose Open as Web App if offered, ' +
      'then tap Add. iPhone installation ' +
      'uses the browser menu, not an ' +
      'App Store download.'
    );
  });
})();
