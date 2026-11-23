// Fills in the current year in the footer. External file so the site's CSP allows it.
(function () {
  "use strict";
  var year = document.getElementById("year");
  if (year) year.textContent = new Date().getFullYear();
})();
