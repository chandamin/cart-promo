(function () {
  var PROXY_URL = "/apps/cartpromo/gift-rules";
  var PROPERTY_KEY = "_cartpromo_rule";
  var syncing = false;
  var syncPending = false;
  var modalRoot = null;
  // Unpatched fetch for our own cart mutations, so they don't re-trigger sync.
  var nativeFetch = window.fetch.bind(window);

  var DEFAULT_SETTINGS = {
    eyebrow_text: "Free Gift",
    heading_text: "Your Complimentary Gift",
    subtext: "Add it to your bag below — on the house.",
    yours_free_text: "Yours, Free",
    button_text: "Add to cart",
    continue_text: "Continue shopping",
    background_color: "#FAF6EF",
    eyebrow_color: "#B08D57",
    heading_color: "#2B2620",
    text_color: "#6B6259",
    button_background_color: "#B08D57",
    button_text_color: "#FFFFFF",
    overlay_color: "#000000",
    overlay_opacity: 50,
    corner_radius: 4,
    cart_refresh: "auto",
  };

  function getRootEl() {
    return document.querySelector("[data-cartpromo-gift-embed]");
  }

  function getSettings() {
    var root = getRootEl();
    if (!root) return DEFAULT_SETTINGS;
    try {
      var parsed = JSON.parse(root.getAttribute("data-settings") || "{}");
      var merged = {};
      for (var key in DEFAULT_SETTINGS) {
        merged[key] = parsed[key] !== undefined && parsed[key] !== "" ? parsed[key] : DEFAULT_SETTINGS[key];
      }
      return merged;
    } catch {
      return DEFAULT_SETTINGS;
    }
  }

  function toGid(kind, id) {
    return "gid://shopify/" + kind + "/" + id;
  }

  function fetchCart() {
    return fetch("/cart.js", { headers: { Accept: "application/json" } }).then(function (r) {
      return r.json();
    });
  }

  function linesPayload(cart) {
    return cart.items.map(function (item) {
      return {
        productId: toGid("Product", item.product_id),
        variantId: toGid("ProductVariant", item.variant_id),
        quantity: item.quantity,
      };
    });
  }

  function fetchQualifyingRules(cart) {
    var params = new URLSearchParams();
    params.set("lines", JSON.stringify(linesPayload(cart)));
    var codes = (cart.discount_codes || [])
      .filter(function (d) {
        return d.applicable;
      })
      .map(function (d) {
        return d.code;
      });
    params.set("codes", JSON.stringify(codes));
    return fetch(PROXY_URL + "?" + params.toString(), { headers: { Accept: "application/json" } })
      .then(function (r) {
        return r.ok ? r.json() : { qualifying: [], giftVariantIds: [] };
      })
      .catch(function () {
        return { qualifying: [], giftVariantIds: [] };
      });
  }

  function currentGiftLines(cart) {
    return cart.items.filter(function (item) {
      return item.properties && item.properties[PROPERTY_KEY];
    });
  }

  // Stores the rule id (not the variant id) so the checkout extension, which
  // reads the same key, can match the line to its rule.
  function addGift(variantId, ruleId) {
    var numericId = variantId.split("/").pop();
    var props = {};
    props[PROPERTY_KEY] = ruleId;
    return nativeFetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: numericId, quantity: 1, properties: props }),
    });
  }

  function removeLine(line) {
    return nativeFetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: line.key, quantity: 0 }),
    });
  }

  function rootUrl() {
    return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  }

  function parseHTML(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  // Id of the section wrapping `el` (for Section Rendering API), or `fallback`
  // when the element is rendered outside a section (e.g. from the layout).
  function sectionIdOf(el, fallback) {
    var section = el && el.closest(".shopify-section");
    var prefix = "shopify-section-";
    return section && section.id.indexOf(prefix) === 0 ? section.id.slice(prefix.length) : fallback;
  }

  function fetchSections(ids) {
    return fetch(rootUrl() + "?sections=" + ids.map(encodeURIComponent).join(","))
      .then(function (r) {
        return r.ok ? r.json() : {};
      })
      .catch(function () {
        return {};
      });
  }

  // Dawn and Dawn-based themes (<cart-drawer> + .drawer__inner, #cart-icon-bubble).
  // Mirrors Dawn's own renderContents. We deliberately don't publish Dawn's
  // cartUpdate pub/sub event: some Dawn versions handle it by injecting the
  // cart *page* markup into the drawer.
  function refreshDawnCart(cart) {
    var drawer = document.querySelector("cart-drawer");
    var bubble = document.getElementById("cart-icon-bubble");
    var drawerSection = drawer && drawer.querySelector(".drawer__inner") ? sectionIdOf(drawer, "cart-drawer") : null;
    var bubbleSection = bubble ? sectionIdOf(bubble, "cart-icon-bubble") : null;
    var ids = [drawerSection, bubbleSection].filter(Boolean);
    if (!ids.length) return Promise.resolve(false);

    return fetchSections(ids).then(function (sections) {
      if (drawerSection && sections[drawerSection]) {
        var doc = parseHTML(sections[drawerSection]);
        var sourceInner = doc.querySelector(".drawer__inner");
        var targetInner = drawer.querySelector(".drawer__inner");
        if (sourceInner && targetInner) {
          targetInner.innerHTML = sourceInner.innerHTML;
          targetInner.className = sourceInner.className;
        }
        // Dawn puts is-empty on <cart-drawer> itself; it drives the empty layout.
        drawer.classList.toggle("is-empty", cart.item_count === 0);
      }
      if (bubbleSection && sections[bubbleSection]) {
        var source = parseHTML(sections[bubbleSection]).querySelector(".shopify-section");
        if (source) bubble.innerHTML = source.innerHTML;
      }
      return true;
    });
  }

  var emittingThemeEvents = false;

  // Events other themes listen to for re-rendering their own cart UI. Fired on
  // <html> with bubbles so listeners on either documentElement or document hear it.
  function emitThemeEvents(cart) {
    var target = document.documentElement;
    var fire = function (name, detail) {
      target.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail }));
    };
    emittingThemeEvents = true;
    try {
      fire("cartpromo:gift-sync", { cart: cart });
      // Horizon and other themes on Shopify's theme event conventions.
      fire("cart:update", {
        resource: cart,
        sourceId: "cartpromo",
        data: { source: "cartpromo", itemCount: cart.item_count },
      });
      // Common convention in third-party themes.
      fire("cart:refresh", { cart: cart });
    } finally {
      emittingThemeEvents = false;
    }
  }

  // Our /cart/*.js calls bypass the theme, so its cart UI must be refreshed.
  function refreshCartUI() {
    return fetchCart()
      .then(function (cart) {
        // Cart page sections have template-specific ids, and some themes can't
        // be refreshed in place at all: the merchant can opt into a reload.
        if (getSettings().cart_refresh === "reload" || /\/cart\/?$/.test(window.location.pathname)) {
          window.location.reload();
          return;
        }
        emitThemeEvents(cart);
        return refreshDawnCart(cart);
      })
      .catch(function () {});
  }

  function closeModal() {
    if (modalRoot) {
      modalRoot.remove();
      modalRoot = null;
      document.removeEventListener("keydown", onKeydown);
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape") closeModal();
  }

  function giftCard(gift, s, onPick) {
    var card = document.createElement("div");
    card.style.cssText = "text-align:center;margin-bottom:16px;";

    if (gift.image) {
      var imgWrap = document.createElement("div");
      imgWrap.style.cssText =
        "width:140px;height:140px;margin:0 auto 12px;border:1px solid " +
        s.eyebrow_color +
        "33;border-radius:" +
        Math.min(s.corner_radius, 12) +
        "px;overflow:hidden;background:#fff;display:flex;align-items:center;justify-content:center;";
      var img = document.createElement("img");
      img.src = gift.image;
      img.alt = gift.title;
      img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;";
      imgWrap.appendChild(img);
      card.appendChild(imgWrap);
    }

    var title = document.createElement("div");
    title.textContent = gift.title;
    title.style.cssText = "font-weight:600;color:" + s.heading_color + ";margin-bottom:4px;";
    card.appendChild(title);

    var freeLabel = document.createElement("div");
    freeLabel.textContent = s.yours_free_text;
    freeLabel.style.cssText =
      "font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:" + s.text_color + ";margin-bottom:12px;";
    card.appendChild(freeLabel);

    var btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = s.button_text;
    btn.style.cssText =
      "display:block;width:100%;padding:12px 16px;border:none;border-radius:" +
      s.corner_radius +
      "px;background:" +
      s.button_background_color +
      ";color:" +
      s.button_text_color +
      ";font-size:14px;font-weight:600;letter-spacing:.03em;cursor:pointer;";
    btn.addEventListener("click", function () {
      onPick(gift.variantId);
    });
    card.appendChild(btn);

    return card;
  }

  function showModal(rule, onPick) {
    closeModal();
    var s = getSettings();

    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9998;background:" +
      hexToRgba(s.overlay_color, s.overlay_opacity) +
      ";display:flex;align-items:center;justify-content:center;padding:16px;";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeModal();
    });

    var card = document.createElement("div");
    card.style.cssText =
      "position:relative;z-index:9999;background:" +
      s.background_color +
      ";border-radius:" +
      s.corner_radius +
      "px;max-width:380px;width:100%;padding:32px 28px;text-align:center;" +
      "box-shadow:0 10px 40px rgba(0,0,0,.2);font-family:inherit;";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.style.cssText =
      "position:absolute;top:12px;right:14px;border:none;background:none;color:" +
      s.text_color +
      ";font-size:20px;line-height:1;cursor:pointer;";
    closeBtn.addEventListener("click", closeModal);
    card.appendChild(closeBtn);

    var eyebrow = document.createElement("div");
    eyebrow.textContent = s.eyebrow_text;
    eyebrow.style.cssText =
      "font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:" +
      s.eyebrow_color +
      ";margin-bottom:6px;";
    card.appendChild(eyebrow);

    var rule1 = document.createElement("div");
    rule1.style.cssText = "width:32px;height:1px;background:" + s.eyebrow_color + ";margin:0 auto 16px;";
    card.appendChild(rule1);

    var heading = document.createElement("div");
    heading.textContent = s.heading_text;
    heading.style.cssText =
      "font-family:Georgia,'Times New Roman',serif;font-style:italic;font-size:24px;color:" +
      s.heading_color +
      ";margin-bottom:8px;";
    card.appendChild(heading);

    var subtext = document.createElement("div");
    subtext.textContent = s.subtext;
    subtext.style.cssText = "font-size:14px;color:" + s.text_color + ";margin-bottom:20px;";
    card.appendChild(subtext);

    rule.gifts.forEach(function (gift) {
      card.appendChild(
        giftCard(gift, s, function (variantId) {
          closeModal();
          onPick(variantId);
        }),
      );
    });

    var continueLink = document.createElement("button");
    continueLink.type = "button";
    continueLink.textContent = s.continue_text;
    continueLink.style.cssText =
      "border:none;background:none;color:" +
      s.text_color +
      ";text-decoration:underline;font-size:13px;cursor:pointer;margin-top:4px;";
    continueLink.addEventListener("click", closeModal);
    card.appendChild(continueLink);

    overlay.appendChild(card);
    document.body.appendChild(overlay);
    modalRoot = overlay;
    document.addEventListener("keydown", onKeydown);
  }

  function hexToRgba(hex, opacityPercent) {
    var clean = hex.replace("#", "");
    if (clean.length === 3) {
      clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
    }
    var r = parseInt(clean.substring(0, 2), 16);
    var g = parseInt(clean.substring(2, 4), 16);
    var b = parseInt(clean.substring(4, 6), 16);
    var alpha = Math.max(0, Math.min(100, Number(opacityPercent))) / 100;
    if (isNaN(r) || isNaN(g) || isNaN(b)) return "rgba(0,0,0," + alpha + ")";
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function finishSync() {
    syncing = false;
    if (syncPending) {
      syncPending = false;
      debouncedSync();
    }
  }

  function sync() {
    // A cart change during a running sync must not be lost: re-run afterwards.
    if (syncing) {
      syncPending = true;
      return;
    }
    syncing = true;
    fetchCart()
      .then(function (cart) {
        return fetchQualifyingRules(cart).then(function (result) {
          return { cart: cart, result: result };
        });
      })
      .then(function (data) {
        var cart = data.cart;
        var qualifyingRuleIds = data.result.qualifying.map(function (q) {
          return q.ruleId;
        });
        var giftLines = currentGiftLines(cart);

        var staleLines = giftLines.filter(function (line) {
          var ruleId = line.properties[PROPERTY_KEY];
          if (qualifyingRuleIds.indexOf(ruleId) !== -1) return false;
          // Lines added before the property held the rule id stored the variant gid.
          return !findRuleIdForVariant(data.result.qualifying, toGid("ProductVariant", line.variant_id));
        });

        var toRemove = staleLines.slice();
        var showFor = null;

        // Never auto-add: a qualifying gift always waits for the customer to
        // confirm via the modal, whether there's one option or several.
        data.result.qualifying.forEach(function (q) {
          var alreadyHasOne = q.gifts.some(function (g) {
            return giftLines.some(function (line) {
              return line.variant_id === Number(g.variantId.split("/").pop());
            });
          });
          if (alreadyHasOne || showFor) return;
          showFor = q;
        });

        var chain = Promise.resolve();
        toRemove.forEach(function (line) {
          chain = chain.then(function () {
            return removeLine(line);
          });
        });
        return chain.then(function () {
          return { changed: toRemove.length > 0, showFor: showFor };
        });
      })
      .then(function (outcome) {
        finishSync();
        if (outcome.showFor) {
          var ruleId = outcome.showFor.ruleId;
          showModal(outcome.showFor, function (variantId) {
            addGift(variantId, ruleId).then(refreshCartUI).then(sync);
          });
        } else {
          closeModal();
        }
        if (outcome.changed) {
          refreshCartUI();
        }
      })
      .catch(function () {
        finishSync();
      });
  }

  function findRuleIdForVariant(qualifying, variantId) {
    for (var i = 0; i < qualifying.length; i++) {
      for (var j = 0; j < qualifying[i].gifts.length; j++) {
        if (qualifying[i].gifts[j].variantId === variantId) return qualifying[i].ruleId;
      }
    }
    return null;
  }

  function debounce(fn, wait) {
    var t;
    return function () {
      clearTimeout(t);
      t = setTimeout(fn, wait);
    };
  }

  var debouncedSync = debounce(sync, 300);

  // Patch fetch to catch AJAX cart mutations regardless of theme.
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && input.url;
    var isCartMutation = url && /\/cart\/(add|change|update|clear)(\.js)?/.test(url);
    var result = originalFetch.apply(this, arguments);
    if (isCartMutation) {
      result.then(function () {
        debouncedSync();
      });
    }
    return result;
  };

  function onThemeCartEvent() {
    if (!emittingThemeEvents) debouncedSync();
  }
  document.addEventListener("cart:updated", onThemeCartEvent);
  document.addEventListener("cart:refresh", onThemeCartEvent);
  document.addEventListener("DOMContentLoaded", sync);
  if (document.readyState !== "loading") sync();
})();
