/* Налаштування тренажера.
 * REPORT_URL – адреса веб-застосунку Google Apps Script, що записує спроби учнів у Google-таблицю
 *              (див. інструкцію в README.md). Поки адреса порожня, тренажер працює без надсилання звітів.
 * RUN_TIMEOUT_MS – максимальний час виконання програми учня (захист від нескінченних циклів). */
window.CONFIG = {
  REPORT_URL: 'https://script.google.com/macros/s/AKfycbzVIU-SI_MwX6yCSrc_F8KwyGCj-oAPjfgWonWuUMaMC073K5Bj8uoxTJA4D5N7C7Q_/exec',
  RUN_TIMEOUT_MS: 4000,
};
