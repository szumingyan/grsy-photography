(function () {
  'use strict';

  // ===== 状态 =====
  const state = {
    works: [],
    currentFilter: 'all',
    filteredWorks: [],
    sortedWorks: [],
    lightboxIndex: 0,
  };

  // ===== DOM =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const els = {
    gallery: $('#gallery'),
    filters: $('#filters'),
    lb: $('#lightbox'),
    lbImg: $('#lbImg'),
    lbCaption: $('#lbCaption'),
    lbCurrent: $('#lbCurrent'),
    lbTotal: $('#lbTotal'),
    lbClose: $('#lightbox .lb-close'),
    lbPrev: $('#lightbox .lb-prev'),
    lbNext: $('#lightbox .lb-next'),
    lbBackdrop: $('#lightbox .lb-backdrop'),
    nav: $('#nav'),
    navToggle: $('#navToggle'),
    navLinks: $('.nav-links'),
    backToTop: $('#backToTop'),
    preloader: $('#preloader'),
    statWorks: $('#statWorks'),
    statCats: $('#statCats'),
    year: $('#year'),
  };

  // ===== 工具函数 =====
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  // 生成占位符渐变背景（与服务端一致的配色方案）
  const PLACEHOLDER_COLORS = {
    '人像': ['#667eea', '#764ba2'],
    '风光': ['#11998e', '#38ef7d'],
    '人文': ['#f7971e', '#ffd200'],
    '建筑': ['#373B44', '#4286f4'],
    '静物': ['#f953c6', '#b91d73'],
    '黑白': ['#232526', '#414345'],
    '作品集': ['#6366f1', '#8b5cf6'],
    '其他': ['#434343', '#000000'],
  };
  function getPlaceholderGradient(id, category) {
    const colors = PLACEHOLDER_COLORS[category] || PLACEHOLDER_COLORS['其他'];
    const hash = (id || '').split('').reduce((h, c) => {
      h = ((h << 5) - h) + c.charCodeAt(0);
      return h & h;
    }, 0);
    const angle = Math.abs(hash) % 360;
    return `linear-gradient(${angle}deg, ${colors[0]}, ${colors[1]})`;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }

  // ===== 预加载 =====
  function initPreloader() {
    if (!els.preloader) return;
    window.addEventListener('load', () => {
      setTimeout(() => {
        els.preloader.classList.add('hide');
        setTimeout(() => {
          els.preloader.style.display = 'none';
        }, 600);
      }, 500);
    });

    // 兜底：3秒后强制隐藏
    setTimeout(() => {
      if (!els.preloader.classList.contains('hide')) {
        els.preloader.classList.add('hide');
        setTimeout(() => {
          if (els.preloader.parentNode) {
            els.preloader.style.display = 'none';
          }
        }, 600);
      }
    }, 3000);
  }

  // ===== 导航滚动效果 =====
  function initNavScroll() {
    let ticking = false;
    function updateNav() {
      const scrolled = window.scrollY > 50;
      els.nav.classList.toggle('scrolled', scrolled);
      els.backToTop.classList.toggle('visible', window.scrollY > 400);
      ticking = false;
    }
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(updateNav);
        ticking = true;
      }
    });
    updateNav();
  }

  // ===== 移动端菜单 =====
  function initMobileNav() {
    if (!els.navToggle) return;
    els.navToggle.addEventListener('click', () => {
      els.navLinks.classList.toggle('active');
    });

    // 点击链接后关闭
    els.navLinks.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => {
        els.navLinks.classList.remove('active');
      });
    });
  }

  // ===== 回到顶部 =====
  function initBackToTop() {
    if (!els.backToTop) return;
    els.backToTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ===== 滚动显现动画 =====
  function initScrollReveal() {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    $$('.reveal').forEach((el) => observer.observe(el));
  }

  // ===== 加载作品 =====
  async function loadWorks() {
    try {
      const res = await fetch('api/works.json');
      if (!res.ok) throw new Error('加载失败');
      state.works = await res.json();
      state.filteredWorks = state.works;

      // 统计
      updateStats();

      renderWorks();
      renderFilters();
    } catch (err) {
      console.error('加载作品失败:', err);
      els.gallery.innerHTML = `
        <div class="loading">
          <div class="loading-spinner"></div>
          <span>加载失败，请刷新重试</span>
        </div>`;
    }
  }

  function updateStats() {
    if (els.statWorks) {
      animateNumber(els.statWorks, state.works.length);
    }
    if (els.statCats) {
      const cats = new Set(state.works.map((w) => w.subcategory || w.category).filter(Boolean));
      animateNumber(els.statCats, cats.size);
    }
    if (els.year) {
      els.year.textContent = new Date().getFullYear();
    }
  }

  function animateNumber(el, target) {
    const duration = 1500;
    const start = performance.now();
    const startVal = 0;

    function update(now) {
      const progress = Math.min((now - start) / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = Math.floor(startVal + (target - startVal) * easeOut);
      el.textContent = current.toLocaleString();
      if (progress < 1) {
        requestAnimationFrame(update);
      } else {
        el.textContent = target.toLocaleString();
      }
    }
    requestAnimationFrame(update);
  }

  // ===== 渲染作品 =====
  function renderWorks() {
    if (!els.gallery) return;
    els.gallery.innerHTML = '';

    if (state.filteredWorks.length === 0) {
      els.gallery.innerHTML = `
        <div class="loading">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
            <circle cx="11" cy="11" r="8"/>
            <path d="M21 21l-4.35-4.35"/>
          </svg>
          <p>暂无作品</p>
          <p style="font-size:13px">${state.currentFilter === 'all' ? '请先在管理后台添加作品' : '该分类下暂无作品'}</p>
        </div>`;
      return;
    }

    // 按时间倒序
    state.sortedWorks = [...state.filteredWorks].sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    state.sortedWorks.forEach((work, index) => {
      const item = createWorkItem(work, index);
      els.gallery.appendChild(item);
    });

    // 显示动画
    requestAnimationFrame(() => {
      els.gallery.querySelectorAll('.work-item').forEach((item, i) => {
        setTimeout(() => {
          item.classList.add('visible');
        }, i * 80);
      });
    });
  }

  function createWorkItem(work, index) {
    const div = document.createElement('div');
    div.className = 'work-item';
    div.dataset.index = index;
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', work.title || '摄影作品');

    const imageUrl = work.url || '';
    // 预览图地址：/uploads/xxx.png → /uploads-previews/xxx.jpg（预览缺失时回退原图）
    const previewUrl = imageUrl
      ? imageUrl.replace(/\/uploads\//, '/uploads-previews/').replace(/^uploads\//, 'uploads-previews/').replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '.jpg')
      : '';
    const placeholderGradient = getPlaceholderGradient(work.id, work.subcategory || work.category);
    const fallbackSvg = `data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 800 600%22><rect width=%22800%22 height=%22600%22 fill=%22%23333%22/><text x=%22400%22 y=%22300%22 text-anchor=%22middle%22 fill=%22%23aaa%22 font-size=%2224%22 font-family=%22sans-serif%22>${encodeURIComponent(work.subcategory || work.category || '')}</text></svg>`;

    div.innerHTML = `
      <img src="${escapeHtml(previewUrl || imageUrl)}" alt="${escapeHtml(work.title || '')}" loading="lazy">
      <div class="work-item-cat">${escapeHtml(work.subcategory || work.category || '未分类')}</div>
      <div class="work-item-overlay">
        <div class="work-item-info">
          <h3 class="work-item-title">${escapeHtml(work.title || '无题')}</h3>
          <p class="work-item-desc">${escapeHtml(work.description || '')}</p>
        </div>
      </div>
    `;

    // 加载失败回退：预览图 → 原图 → 占位图
    const imgEl = div.querySelector('img');
    imgEl.onerror = function () {
      if (!this.dataset.fb && imageUrl && !this.src.endsWith(imageUrl)) {
        this.dataset.fb = '1';
        this.src = imageUrl;
        return;
      }
      this.onerror = null;
      this.style.background = placeholderGradient;
      this.src = fallbackSvg;
      this.classList.add('img-fallback');
    };

    const openLightboxHandler = () => {
      openLightbox(index);
    };

    div.addEventListener('click', openLightboxHandler);
    div.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openLightboxHandler();
      }
    });

    return div;
  }

  // ===== 渲染分类筛选 =====
  function renderFilters() {
    if (!els.filters) return;

    // Collect unique subcategories from works
    const categoryMap = {};
    state.works.forEach((w) => {
      const cat = w.subcategory || w.category;
      if (cat) {
        categoryMap[cat] = (categoryMap[cat] || 0) + 1;
      }
    });
    const categories = Object.keys(categoryMap).sort();

    const allCount = state.works.length;

    let html = `
      <button class="filter-btn ${state.currentFilter === 'all' ? 'active' : ''}" data-cat="all">
        全部作品
        <span class="filter-count">(${allCount})</span>
      </button>
    `;

    categories.forEach((cat) => {
      html += `
        <button class="filter-btn ${state.currentFilter === cat ? 'active' : ''}" data-cat="${escapeHtml(cat)}">
          ${escapeHtml(cat)}
          <span class="filter-count">(${categoryMap[cat]})</span>
        </button>
      `;
    });

    els.filters.innerHTML = html;

    els.filters.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        filterByCategory(cat);
      });
    });
  }

  // ===== 分类筛选 =====
  function filterByCategory(category) {
    state.currentFilter = category;

    if (category === 'all') {
      state.filteredWorks = state.works;
    } else {
      state.filteredWorks = state.works.filter((w) => (w.subcategory || w.category) === category);
    }

    // 更新按钮状态
    els.filters.querySelectorAll('.filter-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.cat === category);
    });

    // 平滑重置
    els.gallery.style.opacity = '0';
    els.gallery.style.transform = 'translateY(20px)';
    els.gallery.style.transition = 'opacity 0.4s ease, transform 0.4s ease';

    setTimeout(() => {
      renderWorks();
      els.gallery.style.opacity = '1';
      els.gallery.style.transform = 'translateY(0)';
    }, 300);
  }

  // ===== 灯箱 =====
  function openLightbox(index) {
    if (state.sortedWorks.length === 0) return;
    state.lightboxIndex = index;
    updateLightbox();
    els.lb.classList.add('active');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    els.lb.classList.remove('active');
    document.body.style.overflow = '';
  }

  function prevLightbox(e) {
    if (e) e.stopPropagation();
    state.lightboxIndex =
      (state.lightboxIndex - 1 + state.sortedWorks.length) % state.sortedWorks.length;
    updateLightbox();
  }

  function nextLightbox(e) {
    if (e) e.stopPropagation();
    state.lightboxIndex = (state.lightboxIndex + 1) % state.sortedWorks.length;
    updateLightbox();
  }

  function updateLightbox() {
    const work = state.sortedWorks[state.lightboxIndex];
    if (!work) return;

    els.lbImg.src = work.url || '';
    els.lbImg.alt = work.title || '';

    // 构建标题 + 描述
    const title = work.title || '无题';
    const desc = work.description || work.subcategory || work.category || '';
    els.lbCaption.textContent = desc ? `${title} — ${desc}` : title;

    if (els.lbCurrent) els.lbCurrent.textContent = state.lightboxIndex + 1;
    if (els.lbTotal) els.lbTotal.textContent = state.sortedWorks.length;
  }

  function initLightbox() {
    if (els.lbClose) els.lbClose.addEventListener('click', closeLightbox);
    if (els.lbPrev) els.lbPrev.addEventListener('click', prevLightbox);
    if (els.lbNext) els.lbNext.addEventListener('click', nextLightbox);
    if (els.lbBackdrop) els.lbBackdrop.addEventListener('click', closeLightbox);

    els.lb.addEventListener('click', (e) => {
      if (e.target === els.lb) closeLightbox();
    });

    document.addEventListener('keydown', (e) => {
      if (!els.lb.classList.contains('active')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') prevLightbox();
      if (e.key === 'ArrowRight') nextLightbox();
    });
  }

  // ===== 平滑滚动 =====
  function initSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener('click', function (e) {
        const targetId = this.getAttribute('href');
        if (targetId === '#') return;
        const target = document.querySelector(targetId);
        if (target) {
          e.preventDefault();
          const offset = 80;
          const top = target.getBoundingClientRect().top + window.pageYOffset - offset;
          window.scrollTo({ top, behavior: 'smooth' });
        }
      });
    });
  }

  // ===== 鼠标视差效果 =====
  function initMouseParallax() {
    const heroInner = document.querySelector('.hero-inner');
    if (!heroInner) return;

    document.addEventListener('mousemove', (e) => {
      if (window.scrollY > window.innerHeight) return;
      const x = (e.clientX / window.innerWidth - 0.5) * 20;
      const y = (e.clientY / window.innerHeight - 0.5) * 20;
      heroInner.style.transform = `translate(${x}px, ${y}px)`;
    });
  }

  // ===== 初始化 =====
  document.addEventListener('DOMContentLoaded', () => {
    initPreloader();
    initNavScroll();
    initMobileNav();
    initBackToTop();
    initScrollReveal();
    initLightbox();
    initSmoothScroll();
    initMouseParallax();
    loadWorks();
  });
})();