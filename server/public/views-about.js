'use strict';
/* About: what the software is, who is behind it, and how to reach them. The content lives in company.js so this page and the public /about.html always agree. */

NAV.push(['about', 'About']);
VIEWS.about = async main => { main.innerHTML = window.aboutHtml(); };
