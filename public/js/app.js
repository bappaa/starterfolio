document.addEventListener('DOMContentLoaded', () => {
  const userBtn = document.getElementById('userMenuBtn');
  const dropdown = document.getElementById('userDropdown');
  if (userBtn) {
    userBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.classList.toggle('show');
    });
    document.addEventListener('click', () => dropdown.classList.remove('show'));
  }

  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('navLinks');
  if (hamburger) {
    hamburger.addEventListener('click', () => {
      navLinks.style.display = navLinks.style.display === 'flex' ? 'none' : 'flex';
      navLinks.style.flexDirection = 'column';
      navLinks.style.position = 'absolute';
      navLinks.style.top = '68px';
      navLinks.style.left = '0';
      navLinks.style.right = '0';
      navLinks.style.background = '#101728';
      navLinks.style.padding = '16px 24px';
      navLinks.style.borderBottom = '1px solid #223047';
    });
  }

  // Order calculator
  const qtyInput = document.getElementById('quantity');
  const rateEl = document.getElementById('svcRate');
  const chargeEl = document.getElementById('calcCharge');
  if (qtyInput && rateEl && chargeEl) {
    const rate = parseFloat(rateEl.dataset.rate);
    const currency = rateEl.dataset.currency || '₹';
    const update = () => {
      const qty = parseFloat(qtyInput.value) || 0;
      const charge = (qty / 1000) * rate;
      chargeEl.textContent = currency + charge.toFixed(2);
    };
    qtyInput.addEventListener('input', update);
    update();
  }

  // Deposit amount chips — each group targets its own amount input (data-target), and only
  // clears the "active" highlight within its own group of chips, so the two payment methods
  // on the Add Funds page (instant gateway vs. manual QR) don't interfere with each other.
  document.querySelectorAll('.amount-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const targetId = chip.dataset.target || 'depositAmount';
      const amountInput = document.getElementById(targetId);
      if (!amountInput) return;
      const group = chip.closest('form') || document;
      group.querySelectorAll('.amount-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      amountInput.value = chip.dataset.amount;
    });
  });

  // Services filter chips (client-side navigation handled via links, this is just visual)
  document.querySelectorAll('.chip[data-cat]').forEach(chip => {
    chip.addEventListener('click', () => {
      window.location.href = '/services' + (chip.dataset.cat ? ('?category=' + chip.dataset.cat) : '');
    });
  });
});
