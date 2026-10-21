// "Email → Nextly" bookmarklet for Chrome and Safari (Windows and Mac).
//
// Hands the open Gmail message to the Nextly app on this computer through a
// nextly:// link. The app adds it to the Inbox with an email card and opens it.
// No server address or password is involved, so it also works offline.
// The first time, the browser asks to open Nextly; tick "Always allow".
//
// Install: create a bookmark and paste the one line from bookmarklet.txt as
// its URL. That line is this file, minified.
(() => {
  const subject = (document.querySelector('h2[data-thread-perm-id], h2.hP')?.textContent
    || document.title.replace(/( - \S+@\S+)? - Gmail$/, '')).trim();
  // The message id makes a link that opens the same email on any device.
  const id = document.querySelector('[data-legacy-message-id]')?.getAttribute('data-legacy-message-id');
  const url = id ? `https://mail.google.com/mail/u/0/#all/${id}` : location.href;
  location.href = `nextly://add?title=${encodeURIComponent(subject)}&url=${encodeURIComponent(url)}`;
})();
