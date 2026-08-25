(() => {
  const year = document.querySelector('[data-year]');
  if (year) year.textContent = new Date().getFullYear();

  document.querySelectorAll('[data-coming-soon]').forEach((button) => {
    button.addEventListener('click', () => {
      const notice = document.querySelector('#developmentNotice');
      if (notice) notice.showModal();
    });
  });
})();
