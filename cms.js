/**
 * Site content hydration.
 *
 * The hardcoded markup in index.html is the fallback: whatever the CMS has
 * saved is layered on top at load time. If the content API is unreachable the
 * page simply keeps its built-in copy, so the site can never be broken by a
 * bad save or a storage outage.
 *
 * Each section is applied independently and defensively.
 */
(function () {
  'use strict';

  var POSITIONS = ['center', 'top', 'bottom', 'left', 'right'];
  var PUB_COLORS = ['blue', 'indigo', 'emerald', 'amber', 'cyan', 'teal', 'violet', 'purple', 'rose', 'sky'];
  var REC_COLORS = /^text-(blue|indigo|emerald|amber|cyan|teal|violet|purple|rose|sky)-\d00$/;
  var STAT_COLORS = {
    blue: { num: 'text-blue-400', icon: 'text-blue-400/70', hov: 'group-hover:text-blue-300' },
    emerald: { num: 'text-emerald-400', icon: 'text-emerald-400/70', hov: 'group-hover:text-emerald-300' },
    amber: { num: 'text-amber-400', icon: 'text-amber-400/70', hov: 'group-hover:text-amber-300' },
    rose: { num: 'text-rose-400', icon: 'text-rose-400/70', hov: 'group-hover:text-rose-300' }
  };
  var YOUTUBE_ID = /^[A-Za-z0-9_-]{6,20}$/;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function str(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  function list(value, min) {
    return Array.isArray(value) && value.length >= (min || 1) ? value : null;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function resolvePath(obj, path) {
    return String(path)
      .split('.')
      .reduce(function (acc, key) {
        return acc == null ? undefined : acc[key];
      }, obj);
  }

  /** Repository image paths become API paths; everything else is passed through. */
  function mediaUrl(path) {
    var value = str(path);
    if (!value) return '';
    if (/^(https?:)?\/\//.test(value) || value.indexOf('data:') === 0) return value;
    if (value.indexOf('uploads/') === 0) return '/api/media?path=' + encodeURIComponent(value);
    return value;
  }

  function safePosition(value) {
    return POSITIONS.indexOf(str(value)) === -1 ? '' : value;
  }

  /* ------------------------------------------------------------------ *
   * Simple fields  (data-cms="path", data-cms-html for rich text)
   * ------------------------------------------------------------------ */

  function hydrateFields(content) {
    document.querySelectorAll('[data-cms]').forEach(function (node) {
      var value = resolvePath(content, node.getAttribute('data-cms'));
      if (typeof value !== 'string' || value === '') return;
      if (node.hasAttribute('data-cms-html')) node.innerHTML = value;
      else node.textContent = value;
    });
  }

  /* ------------------------------------------------------------------ *
   * Hero
   * ------------------------------------------------------------------ */

  function hydrateHero(hero) {
    if (!hero) return;

    var title = el('heroTitle');
    if (title && str(hero.titleLine1) && str(hero.accent)) {
      title.innerHTML = esc(hero.titleLine1) + '<br><span class="accent">' + esc(hero.accent) + '</span>';
    }

    var role = el('heroRole');
    if (role && str(hero.role)) {
      role.innerHTML = hero.role
        .split('·')
        .map(function (part) {
          return esc(part.trim());
        })
        .join(' <span class="text-blue-300/55 mx-1.5">·</span> ');
    }

    var slides = list(hero.slides);
    if (!slides) return;
    var track = document.querySelector('.slider-track');
    var dots = document.querySelector('.slider-dots');
    if (track) {
      track.innerHTML = slides
        .map(function (slide, i) {
          var src = mediaUrl(slide && slide.src);
          if (!src) return '';
          var pos = safePosition(slide.pos);
          var cls = 'hero-photo';
          var style = '';
          if (pos === 'center') cls += ' hero-photo-center';
          else if (pos) style = ' style="object-position:' + esc(pos) + '"';
          var extra = i === 0 ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"';
          return (
            '<div class="slider-slide' + (i === 0 ? ' active' : '') + '">' +
            '<img class="' + cls + '"' + style + ' src="' + esc(src) + '" alt="' + esc(slide.alt || '') + '" ' + extra + '>' +
            '</div>'
          );
        })
        .join('');
    }
    if (dots) {
      dots.innerHTML = slides
        .map(function (_, i) {
          return (
            '<button class="slider-dot' + (i === 0 ? ' active' : '') + '" onclick="sGo(' + i + ')" aria-label="Go to slide ' + (i + 1) + '"></button>'
          );
        })
        .join('');
    }
  }

  /* ------------------------------------------------------------------ *
   * Stats
   * ------------------------------------------------------------------ */

  function hydrateStats(stats) {
    if (!stats) return;

    var items = list(stats.items);
    var grid = el('statsGrid');
    if (items && grid) {
      grid.innerHTML = items
        .map(function (item) {
          var c = STAT_COLORS[item && item.color] || STAT_COLORS.blue;
          return (
            '<a href="' + esc(item.href || '#') + '" title="' + esc(item.title || '') + '" class="bg-slate-900 p-8 group hover:bg-slate-800/70 transition-colors duration-300 block cursor-pointer">' +
            '<i class="' + esc(item.icon || 'fa-solid fa-circle') + ' text-2xl ' + c.icon + ' mb-3 block ' + c.hov + ' group-hover:scale-110 transition-all duration-300"></i>' +
            '<div class="text-5xl md:text-6xl font-semibold tracking-tighter ' + c.num + (item.pop ? ' inf-pop' : '') + '" data-count="' + (Number(item.count) || 0) + '">0</div>' +
            '<div class="text-sm text-slate-400 mt-1">' + esc(item.label || '') + '</div>' +
            '</a>'
          );
        })
        .join('');
    }

    var affiliations = list(stats.affiliations);
    var affil = el('affilList');
    if (affiliations && affil) {
      affil.innerHTML =
        '<span class="uppercase tracking-[3px] text-[11px] text-slate-500">Affiliations</span>' +
        affiliations
          .map(function (name) {
            return '<span class="a-item">' + esc(name) + '</span>';
          })
          .join('');
    }
  }

  /* ------------------------------------------------------------------ *
   * About
   * ------------------------------------------------------------------ */

  function hydrateAbout(about) {
    if (!about) return;

    var portrait = el('aboutPortrait');
    if (portrait && about.portrait && str(about.portrait.src)) {
      portrait.src = mediaUrl(about.portrait.src);
      portrait.alt = str(about.portrait.alt) || portrait.alt;
    }

    var badges = list(about.badges);
    var badgeBox = el('aboutBadges');
    if (badges && badgeBox) {
      badgeBox.innerHTML = badges
        .map(function (badge) {
          return '<span class="px-4 py-2 rounded-2xl glass bg-slate-900/80 text-xs font-semibold shadow-xl backdrop-blur">' + esc(badge) + '</span>';
        })
        .join('');
    }

    var paragraphs = list(about.paragraphs);
    var paragraphBox = el('aboutParagraphs');
    if (paragraphs && paragraphBox) {
      paragraphBox.innerHTML = paragraphs
        .map(function (html) {
          return '<p>' + String(html == null ? '' : html) + '</p>';
        })
        .join('');
    }

    var tags = list(about.tags);
    var tagBox = el('aboutTags');
    if (tags && tagBox) {
      tagBox.innerHTML = tags
        .map(function (tag) {
          return (
            '<a href="' + esc(tag.href || '#') + '" class="px-4 py-1.5 text-sm rounded-full border border-blue-400/40 text-blue-300 hover:bg-blue-400/10 hover:border-blue-400/70 hover:shadow-[0_0_16px_rgba(96,165,250,.4)] transition-all duration-300 cursor-pointer">' + esc(tag.label || '') + '</a>'
          );
        })
        .join('');
    }

    var credentials = list(about.credentials);
    var credBox = el('aboutCreds');
    if (credentials && credBox) {
      credBox.innerHTML = credentials
        .map(function (cred) {
          return (
            '<div class="flex items-start gap-3 p-4 rounded-2xl bg-white/5 border border-white/10">' +
            '<i class="' + esc(cred.icon || 'fa-solid fa-circle-check') + ' ' + esc(cred.color || 'text-blue-400') + ' mt-0.5"></i>' +
            '<div class="text-sm"><div class="font-semibold text-white">' + esc(cred.title || '') + '</div><div class="text-slate-400">' + esc(cred.sub || '') + '</div></div>' +
            '</div>'
          );
        })
        .join('');
    }
  }

  /* ------------------------------------------------------------------ *
   * Services
   * ------------------------------------------------------------------ */

  function hydrateServices(services) {
    if (!services) return;
    var items = list(services.items);
    var grid = el('servicesGrid');
    if (!items || !grid) return;
    grid.innerHTML = items
      .map(function (item, i) {
        return (
          '<a href="' + esc(item.href || '#') + '" aria-label="' + esc(item.aria || item.title || '') + '" class="card glass p-8 rounded-3xl reveal d' + ((i % 6) + 1) + ' block group">' +
          '<div class="icon-chip"><i class="' + esc(item.icon || 'fa-solid fa-circle') + '"></i></div>' +
          '<h3 class="font-semibold text-2xl my-3">' + esc(item.title || '') + '</h3>' +
          '<p class="text-slate-300">' + esc(item.text || '') + '</p>' +
          '<div class="text-xs text-slate-500 mt-4 tracking-wide flex items-center justify-between"><span>' + esc(item.meta || '') + '</span><i class="fa-solid fa-arrow-right text-blue-400/70 group-hover:translate-x-1 transition-transform"></i></div>' +
          '</a>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Talks & media
   * ------------------------------------------------------------------ */

  function hydrateMedia(media) {
    if (!media) return;
    var items = list(media.items);
    var grid = el('mediaGrid');
    if (!items || !grid) return;
    grid.innerHTML = items
      .map(function (item) {
        var id = str(item.id) && YOUTUBE_ID.test(item.id) ? item.id : '';
        if (!id) return '';
        var thumb = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
        var grad = /^from-[a-z]+-\d00$/.test(item.grad || '') ? item.grad : 'from-blue-900';
        return (
          '<div class="glass rounded-3xl p-5 reveal card">' +
          '<button onclick="openVideo(\'' + id + '\')" class="video-thumb relative w-full aspect-video rounded-2xl overflow-hidden block bg-gradient-to-br ' + grad + ' to-slate-900 group" aria-label="' + esc(item.aria || 'Play video') + '">' +
          '<img src="' + esc(thumb) + '" alt="' + esc(item.alt || '') + '" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' +
          '<div class="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20"></div>' +
          '<span class="play-btn"><i class="fa-solid fa-play ml-0.5"></i></span>' +
          '<span class="absolute bottom-3 left-4 px-3 py-1 rounded-full glass text-[11px] font-semibold tracking-wider text-white">' + esc(item.badge || 'VIDEO') + '</span>' +
          '</button>' +
          '<div class="p-4"><h3 class="font-semibold text-xl mb-1">' + esc(item.title || '') + '</h3><p class="text-slate-400 text-sm">' + esc(item.text || '') + '</p>' +
          '<a href="https://www.youtube.com/watch?v=' + id + '" target="_blank" rel="noopener" class="mt-2 inline-flex items-center gap-2 text-xs text-slate-400 hover:text-red-400 transition-colors"><i class="fa-brands fa-youtube"></i> Open on YouTube</a></div>' +
          '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Publications
   * ------------------------------------------------------------------ */

  function hydratePublications(pubs) {
    if (!pubs) return;
    var items = list(pubs.items);
    var container = el('pubList');
    if (!items || !container) return;
    container.innerHTML = items
      .map(function (item) {
        var color = PUB_COLORS.indexOf(item.color) === -1 ? 'blue' : item.color;
        var tag = str(item.tag);
        return (
          '<div class="pub card glass p-6 rounded-3xl flex flex-col md:flex-row md:items-start gap-4 reveal" data-url="' + esc(item.url || '') + '" role="button" tabindex="0" aria-expanded="false" title="Click to preview summary — click again to open">' +
          '<div class="pub-cover ' + esc(item.cover || 'c-' + color) + '"><span class="pub-abbr">' + esc(item.abbr || '') + '</span><i class="' + esc(item.icon || 'fa-solid fa-file-lines') + '"></i></div>' +
          '<div class="flex-1">' +
          '<div class="font-semibold text-lg">' + esc(item.title || '') + '</div>' +
          '<div class="text-sm text-slate-400 mt-1">' + esc(item.authors || '') + '</div>' +
          '<div class="flex items-center gap-3 mt-3">' +
          (tag ? '<span class="px-4 py-1 text-xs rounded-full border border-' + color + '-400/40 text-' + color + '-300 w-max">' + esc(tag) + '</span>' : '') +
          '<span class="text-xs text-slate-500">Preview</span></div>' +
          '<div class="pub-summary"><p class="text-sm text-slate-300 leading-relaxed">' + esc(item.summary || '') + '</p><span class="pub-open-link"><i class="fa-solid fa-arrow-up-right-from-square"></i> Read full publication</span></div>' +
          '</div>' +
          '<div class="pub-chevron md:mt-2"><i class="fa-solid fa-chevron-down"></i></div>' +
          '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Recognition
   * ------------------------------------------------------------------ */

  function hydrateRecognition(recognition) {
    if (!recognition) return;
    var items = list(recognition.items);
    var grid = el('recogGrid');
    if (!items || !grid) return;
    grid.innerHTML = items
      .map(function (item, i) {
        var color = REC_COLORS.test(item.color || '') ? item.color : 'text-blue-400';
        return (
          '<div class="card glass p-8 rounded-3xl reveal d' + ((i % 6) + 1) + '">' +
          '<div class="flex items-start justify-between gap-3">' +
          '<i class="' + esc(item.icon || 'fa-solid fa-award') + ' text-3xl ' + color + '"></i>' +
          '<span class="px-3 py-1 rounded-full text-xs font-semibold border border-white/20 text-slate-300">' + esc(item.year || '') + '</span>' +
          '</div>' +
          '<h3 class="font-semibold text-xl mt-5 mb-2">' + esc(item.title || '') + '</h3>' +
          '<div class="text-sm ' + color + ' mb-3">' + esc(item.org || '') + '</div>' +
          '<p class="text-slate-300 text-sm">' + esc(item.text || '') + '</p>' +
          '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Gallery
   * ------------------------------------------------------------------ */

  function hydrateGallery(gallery) {
    if (!gallery) return;
    var items = list(gallery.items);
    var grid = el('galleryGrid');
    if (!items || !grid) return;
    grid.innerHTML = items
      .map(function (item) {
        var src = mediaUrl(item && item.src);
        if (!src) return '';
        return (
          '<div class="gitem rounded-3xl glass reveal' + (item.large ? ' sm:col-span-2 sm:row-span-2' : '') + '" onclick="openLB(this)">' +
          '<img src="' + esc(src) + '" alt="' + esc(item.alt || '') + '" class="w-full h-full object-cover rounded-3xl" loading="lazy" decoding="async">' +
          '</div>'
        );
      })
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Load
   * ------------------------------------------------------------------ */

  async function fetchContent() {
    var fromApi = null;
    try {
      var res = await fetch('/api/content', { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (res.ok) fromApi = await res.json();
    } catch (_) {
      /* fall through to the bundled copy */
    }
    if (fromApi && fromApi.hero) return fromApi;

    try {
      var local = await fetch('content.json', { cache: 'no-store' });
      if (local.ok) {
        var data = await local.json();
        if (data && data.hero) return data;
      }
    } catch (_) {
      /* keep the built-in markup */
    }
    return fromApi || null;
  }

  window.__cmsHydrate = async function () {
    // ?nocms=1 renders the built-in markup only — handy for comparing the two.
    if (/[?&]nocms\b/.test(window.location.search)) return null;
    var content;
    try {
      content = await Promise.race([
        fetchContent(),
        new Promise(function (resolve) {
          setTimeout(function () {
            resolve(null);
          }, 3500);
        })
      ]);
    } catch (_) {
      content = null;
    }
    if (!content || typeof content !== 'object') return null;

    var steps = [
      [hydrateFields, content],
      [hydrateHero, content.hero],
      [hydrateStats, content.stats],
      [hydrateAbout, content.about],
      [hydrateServices, content.services],
      [hydrateMedia, content.media],
      [hydratePublications, content.publications],
      [hydrateRecognition, content.recognition],
      [hydrateGallery, content.gallery]
    ];

    steps.forEach(function (step) {
      try {
        step[0](step[1]);
      } catch (error) {
        console.warn('[cms] could not apply a section', error);
      }
    });

    document.documentElement.setAttribute('data-cms-loaded', 'true');
    return content;
  };
})();
