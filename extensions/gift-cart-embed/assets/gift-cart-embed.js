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
    adding_text: "Adding…",
    continue_text: "Continue shopping",
    reclaim_text: "You've unlocked a free gift – choose it",
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
    show_code_field: true,
    code_placeholder: "Discount or gift code",
    code_button_text: "Apply",
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
        // Before discounts, like the Function's subtotalAmount (cart.js uses cents).
        amount: item.original_line_price / 100,
        isGift: Boolean(item.properties && item.properties[PROPERTY_KEY]),
      };
    });
  }

  // --- Popup dismissal -------------------------------------------------------
  // When the customer closes the popup without taking the gift, don't show it
  // again on every page load: only once the cart's (non-gift) products change.
  var DISMISS_KEY = "cartpromo:gift-dismissed";

  function dismissStorageKey(ruleId) {
    return DISMISS_KEY + ":" + ruleId;
  }

  function cartSignature(cart) {
    return cart.items
      .filter(function (item) {
        return !(item.properties && item.properties[PROPERTY_KEY]);
      })
      .map(function (item) {
        return item.variant_id + ":" + item.quantity;
      })
      .sort()
      .join(",");
  }

  function isDismissed(ruleId, cart) {
    try {
      return window.localStorage.getItem(dismissStorageKey(ruleId)) === cartSignature(cart);
    } catch (e) {
      return false;
    }
  }

  function rememberDismissal(ruleId, cart) {
    try {
      window.localStorage.setItem(dismissStorageKey(ruleId), cartSignature(cart));
    } catch (e) {
      // Storage unavailable (private mode, blocked): popup just shows again.
    }
  }

  function clearDismissal(ruleId) {
    try {
      window.localStorage.removeItem(dismissStorageKey(ruleId));
    } catch (e) {
      // Storage unavailable: nothing was remembered anyway.
    }
  }

  function fetchQualifyingRules(cart) {
    var params = new URLSearchParams();
    params.set("lines", JSON.stringify(linesPayload(cart)));
    // Every code on the cart, not only the `applicable` ones: a gift code only
    // becomes applicable once the gift is in the cart, so requiring it here
    // meant the gift was never offered and the code stayed "not applicable".
    // The server still checks each code against a rule's conditions.
    var codes = (cart.discount_codes || []).map(function (d) {
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
  // Rejects with the reason Shopify gave (sold out, unavailable, ...) so the
  // popup can say why instead of closing as though the gift had been added.
  function addGift(variantId, ruleId) {
    var numericId = variantId.split("/").pop();
    var props = {};
    props[PROPERTY_KEY] = ruleId;
    return nativeFetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: numericId, quantity: 1, properties: props }),
    }).then(function (response) {
      if (response.ok) return response;
      return response
        .json()
        .catch(function () {
          return null;
        })
        .then(function (body) {
          throw new Error((body && (body.description || body.message)) || "This gift could not be added.");
        });
    });
  }

  function removeLine(line) {
    return nativeFetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: line.key, quantity: 0 }),
    });
  }

  function setLineQuantity(line, quantity) {
    return nativeFetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: line.key, quantity: quantity }),
    });
  }

  function rootUrl() {
    return (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) || "/";
  }

  function parseHTML(html) {
    return new DOMParser().parseFromString(html, "text/html");
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
  // Uses Dawn's dedicated `cart-drawer` / `cart-icon-bubble` sections. Don't
  // derive ids from the wrapping .shopify-section: the bubble lives inside the
  // header section, and rendering that into the bubble duplicates the header.
  function refreshDawnCart(cart) {
    var drawer = document.querySelector("cart-drawer");
    var bubble = document.getElementById("cart-icon-bubble");
    var drawerSection = drawer && drawer.querySelector(".drawer__inner") ? "cart-drawer" : null;
    var bubbleSection = bubble ? "cart-icon-bubble" : null;
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

  // Set while the popup is open: closes it as a customer "no thanks".
  var dismissModal = closeModal;

  function onKeydown(e) {
    if (e.key === "Escape") dismissModal();
  }

  function giftCard(gift, s, compact, onPick) {
    var imageSize = compact ? 84 : 140;
    var card = document.createElement("div");
    card.style.cssText = "text-align:center;margin-bottom:" + (compact ? 12 : 16) + "px;";

    if (gift.image) {
      var imgWrap = document.createElement("div");
      imgWrap.style.cssText =
        "width:" +
        imageSize +
        "px;height:" +
        imageSize +
        "px;margin:0 auto 12px;border:1px solid " +
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
      onPick(gift.variantId, btn);
    });
    card.appendChild(btn);

    return card;
  }

  function showModal(rule, onPick, onDismiss) {
    closeModal();
    var s = getSettings();
    dismissModal = function () {
      closeModal();
      if (onDismiss) onDismiss();
    };

    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:9998;background:" +
      hexToRgba(s.overlay_color, s.overlay_opacity) +
      ";display:flex;align-items:center;justify-content:center;padding:16px;";
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) dismissModal();
    });

    var card = document.createElement("div");
    card.style.cssText =
      "position:relative;z-index:9999;background:" +
      s.background_color +
      ";border-radius:" +
      s.corner_radius +
      "px;max-width:380px;width:100%;padding:32px 28px;text-align:center;" +
      "max-height:calc(100vh - 32px);overflow-y:auto;-webkit-overflow-scrolling:touch;" +
      "box-shadow:0 10px 40px rgba(0,0,0,.2);font-family:inherit;";

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.style.cssText =
      "position:absolute;top:12px;right:14px;border:none;background:none;color:" +
      s.text_color +
      ";font-size:20px;line-height:1;cursor:pointer;";
    closeBtn.addEventListener("click", dismissModal);
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

    var error = document.createElement("div");
    error.style.cssText = "display:none;font-size:13px;color:#8E1F0B;margin-bottom:12px;";
    card.appendChild(error);

    var compact = rule.gifts.length > 1;
    rule.gifts.forEach(function (gift) {
      card.appendChild(
        giftCard(gift, s, compact, function (variantId, btn) {
          error.style.display = "none";
          btn.disabled = true;
          btn.style.opacity = "0.6";
          btn.textContent = s.adding_text;
          Promise.resolve(onPick(variantId)).catch(function (e) {
            btn.disabled = false;
            btn.style.opacity = "1";
            btn.textContent = s.button_text;
            error.textContent = (e && e.message) || "This gift could not be added.";
            error.style.display = "block";
          });
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
    continueLink.addEventListener("click", dismissModal);
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

  // The rule a gift line belongs to: its property holds the rule id, or (lines
  // added before that) the variant gid.
  function ruleIdOfLine(line, qualifying) {
    var tag = line.properties[PROPERTY_KEY];
    for (var i = 0; i < qualifying.length; i++) {
      if (qualifying[i].ruleId === tag) return tag;
    }
    return findRuleIdForVariant(qualifying, toGid("ProductVariant", line.variant_id)) || tag;
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
        var qualifying = data.result.qualifying;
        var qualifyingRuleIds = qualifying.map(function (q) {
          return q.ruleId;
        });
        var giftLines = currentGiftLines(cart);

        // 1. Gift lines whose rule no longer qualifies leave the cart.
        var toRemove = giftLines.filter(function (line) {
          var ruleId = line.properties[PROPERTY_KEY];
          if (qualifyingRuleIds.indexOf(ruleId) !== -1) return false;
          // Lines added before the property held the rule id stored the variant gid.
          return !findRuleIdForVariant(qualifying, toGid("ProductVariant", line.variant_id));
        });

        // 2. One gift line, one unit, per rule. The Function never discounts
        // more than that, so anything extra would be a paid "gift": drop the
        // additional lines and put the kept line back to quantity 1.
        var kept = {};
        var toResetQuantity = [];
        giftLines.forEach(function (line) {
          if (toRemove.indexOf(line) !== -1) return;
          var ruleId = ruleIdOfLine(line, qualifying);
          if (kept[ruleId]) {
            toRemove.push(line);
            return;
          }
          kept[ruleId] = line;
          if (line.quantity > 1) toResetQuantity.push(line);
        });

        // 3. What to offer: a single-gift rule is added automatically, a rule
        // with several gifts asks the customer to choose.
        var showFor = null;
        var reclaim = null;
        var autoAdd = [];
        qualifying.forEach(function (q) {
          var alreadyHasOne = !!kept[q.ruleId];
          if (alreadyHasOne) return;
          // Declined (or removed by the customer) for this exact cart: wait for
          // a product change, but keep a way back to the gift.
          if (isDismissed(q.ruleId, cart)) {
            if (!reclaim) reclaim = q;
            return;
          }
          if (q.gifts.length === 1) {
            autoAdd.push(q);
          } else if (!showFor) {
            showFor = q;
          }
        });

        var chain = Promise.resolve();
        toRemove.forEach(function (line) {
          chain = chain.then(function () {
            return removeLine(line);
          });
        });
        toResetQuantity.forEach(function (line) {
          chain = chain.then(function () {
            return setLineQuantity(line, 1);
          });
        });
        var added = false;
        autoAdd.forEach(function (q) {
          chain = chain.then(function () {
            // Remembered like a dismissal, whether or not the add works: if the
            // customer deletes the gift (or it can't be added) it isn't re-added
            // in a loop until the cart's products change.
            rememberDismissal(q.ruleId, cart);
            return addGift(q.gifts[0].variantId, q.ruleId)
              .then(function () {
                added = true;
              })
              .catch(function () {});
          });
        });
        return chain.then(function () {
          return {
            changed: toRemove.length > 0 || toResetQuantity.length > 0 || added,
            showFor: showFor,
            reclaim: reclaim,
            cart: cart,
          };
        });
      })
      .then(function (outcome) {
        finishSync();
        if (outcome.showFor) {
          var ruleId = outcome.showFor.ruleId;
          showModal(
            outcome.showFor,
            function (variantId) {
              clearDismissal(ruleId);
              return addGift(variantId, ruleId).then(function () {
                closeModal();
                return refreshCartUI().then(sync);
              });
            },
            function () {
              rememberDismissal(ruleId, outcome.cart);
              debouncedSync();
            },
          );
        } else {
          closeModal();
        }
        showReclaimLink(outcome.showFor ? null : outcome.reclaim);
        if (outcome.changed) {
          refreshCartUI();
        }
      })
      .catch(function () {
        finishSync();
      });
  }

  // --- Way back to a gift the customer dismissed or removed ------------------
  var reclaimRoot = null;

  function showReclaimLink(q) {
    if (!q) {
      if (reclaimRoot) {
        reclaimRoot.remove();
        reclaimRoot = null;
      }
      return;
    }
    if (reclaimRoot && reclaimRoot.getAttribute("data-rule") === q.ruleId) return;
    if (reclaimRoot) reclaimRoot.remove();

    var s = getSettings();
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("data-cartpromo-reclaim", "");
    btn.setAttribute("data-rule", q.ruleId);
    btn.textContent = s.reclaim_text;
    btn.addEventListener("click", function () {
      clearDismissal(q.ruleId);
      sync();
    });

    // A theme can place the link itself with an element carrying
    // data-cartpromo-gift-slot (e.g. inside its cart drawer); otherwise it
    // floats at the bottom of the screen, which works in every theme.
    var slot = document.querySelector("[data-cartpromo-gift-slot]");
    if (slot) {
      btn.style.cssText =
        "border:none;background:none;padding:0;color:" +
        s.eyebrow_color +
        ";text-decoration:underline;font-size:14px;cursor:pointer;";
      slot.appendChild(btn);
      reclaimRoot = btn;
    } else {
      btn.style.cssText =
        "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9990;max-width:calc(100vw - 32px);" +
        "padding:10px 18px;border:none;border-radius:" +
        Math.max(s.corner_radius, 4) +
        "px;background:" +
        s.button_background_color +
        ";color:" +
        s.button_text_color +
        ";font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.25);";
      document.body.appendChild(btn);
      reclaimRoot = btn;
    }
  }

  // --- Gift code field --------------------------------------------------------
  // Checkout only accepts a code once the cart holds something it discounts, and
  // the gift is added from here (the storefront), not from checkout. So the
  // code is entered on the cart: /discount/CODE puts it on the cart, then sync()
  // sees it among cart.discount_codes and adds the gift.
  var codeRoot = null;

  function applyGiftCode(code, setMessage) {
    setMessage("");
    return nativeFetch("/discount/" + encodeURIComponent(code), { credentials: "same-origin" })
      .then(function () {
        return fetchCart();
      })
      .then(function (cart) {
        var onCart = (cart.discount_codes || []).some(function (d) {
          return d.code.toUpperCase() === code.toUpperCase();
        });
        if (!onCart) {
          setMessage("This code isn't valid.", true);
          return;
        }
        sync();
        // The gift is added by sync(); give it a moment, then say how it went.
        setTimeout(function () {
          fetchCart().then(function (latest) {
            var entry = (latest.discount_codes || []).filter(function (d) {
              return d.code.toUpperCase() === code.toUpperCase();
            })[0];
            if (entry && entry.applicable) {
              setMessage("Code applied.");
              refreshCartUI();
            } else {
              setMessage("This code doesn't apply to your cart yet.", true);
            }
          });
        }, 1500);
      })
      .catch(function () {
        setMessage("Couldn't apply the code. Try again.", true);
      });
  }

  function renderCodeField() {
    if (codeRoot && document.body.contains(codeRoot)) return;
    var s = getSettings();
    if (s.show_code_field === false || s.show_code_field === "false") return;

    var slot = document.querySelector("[data-cartpromo-code-slot]");
    var onCartPage = /\/cart\/?$/.test(window.location.pathname);
    var checkoutButton = document.querySelector('form[action$="/cart"] [name="checkout"], form[action$="/cart"] button[type="submit"]');
    if (!slot && !(onCartPage && checkoutButton)) return;

    var wrap = document.createElement("div");
    wrap.setAttribute("data-cartpromo-code", "");
    wrap.style.cssText = "margin:12px 0;max-width:420px;";
    var row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;";
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = s.code_placeholder || "Discount or gift code";
    input.setAttribute("aria-label", input.placeholder);
    input.style.cssText = "flex:1;min-width:0;padding:10px 12px;border:1px solid #bbb;border-radius:4px;font-size:14px;";
    var button = document.createElement("button");
    button.type = "button";
    button.textContent = s.code_button_text || "Apply";
    button.style.cssText =
      "padding:10px 16px;border:none;border-radius:4px;cursor:pointer;font-size:14px;font-weight:600;background:" +
      s.button_background_color +
      ";color:" +
      s.button_text_color +
      ";";
    var message = document.createElement("div");
    message.style.cssText = "margin-top:6px;font-size:13px;";
    message.setAttribute("role", "status");

    function setMessage(text, isError) {
      message.textContent = text;
      message.style.color = isError ? "#b3261e" : "#2e7d32";
    }
    function submit() {
      var code = input.value.trim();
      if (!code) return;
      button.disabled = true;
      applyGiftCode(code, setMessage).then(function () {
        button.disabled = false;
      });
    }
    button.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    row.appendChild(input);
    row.appendChild(button);
    wrap.appendChild(row);
    wrap.appendChild(message);

    if (slot) {
      slot.appendChild(wrap);
    } else {
      checkoutButton.parentNode.insertBefore(wrap, checkoutButton);
    }
    codeRoot = wrap;
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

  var CART_MUTATION = /\/cart\/(add|change|update|clear)(\.js)?(\?|$|\/)/;

  // Patch fetch to catch AJAX cart mutations regardless of theme.
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input && (input.url || input.href);
    var isCartMutation = url && CART_MUTATION.test(url);
    var result = originalFetch.call(this, input, init);
    if (isCartMutation) {
      result.then(function () {
        debouncedSync();
      });
    }
    return result;
  };

  // Older themes and other apps change the cart with XMLHttpRequest, which the
  // fetch patch can't see; without this a gift that stopped qualifying stayed
  // in the cart at full price until the next page load.
  if (window.XMLHttpRequest) {
    var xhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        this.__cartpromoMutation = CART_MUTATION.test(String(url));
      } catch (e) {
        this.__cartpromoMutation = false;
      }
      return xhrOpen.apply(this, arguments);
    };
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      if (this.__cartpromoMutation) {
        this.addEventListener("loadend", function () {
          debouncedSync();
        });
      }
      return xhrSend.apply(this, arguments);
    };
  }

  function onThemeCartEvent() {
    if (!emittingThemeEvents) debouncedSync();
  }
  document.addEventListener("cart:updated", onThemeCartEvent);
  document.addEventListener("cart:refresh", onThemeCartEvent);
  // Back/forward cache restores and returning to the tab: the cart may have
  // been changed elsewhere (another tab, a form post) while this page slept.
  window.addEventListener("pageshow", function (e) {
    if (e.persisted) debouncedSync();
  });
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") debouncedSync();
  });
  document.addEventListener("DOMContentLoaded", sync);
  document.addEventListener("DOMContentLoaded", renderCodeField);
  if (document.readyState !== "loading") {
    sync();
    renderCodeField();
  }
})();
