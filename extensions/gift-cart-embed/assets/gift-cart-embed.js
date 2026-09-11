(function () {
  var PROXY_URL = "/apps/cartpromo/gift-rules";
  var PROPERTY_KEY = "_cartpromo_rule";
  var syncing = false;
  var pickerRoot = null;

  function getRootEl() {
    return document.querySelector("[data-cartpromo-gift-embed]");
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

  function addGift(variantId) {
    var numericId = variantId.split("/").pop();
    var props = {};
    props[PROPERTY_KEY] = variantId;
    return fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: numericId, quantity: 1, properties: props }),
    });
  }

  function removeLine(line) {
    return fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id: line.key, quantity: 0 }),
    });
  }

  function clearPicker() {
    if (pickerRoot) {
      pickerRoot.remove();
      pickerRoot = null;
    }
  }

  function showPicker(rule, onPick) {
    clearPicker();
    var root = getRootEl();
    if (!root) return;
    pickerRoot = document.createElement("div");
    pickerRoot.style.cssText =
      "position:fixed;bottom:16px;right:16px;z-index:9999;background:#fff;border:1px solid #ddd;" +
      "border-radius:8px;padding:12px;box-shadow:0 2px 10px rgba(0,0,0,.15);max-width:280px;font-size:14px;";
    var title = document.createElement("div");
    title.textContent = "Choose your free gift:";
    title.style.cssText = "font-weight:600;margin-bottom:8px;";
    pickerRoot.appendChild(title);
    rule.gifts.forEach(function (gift) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = gift.title;
      btn.style.cssText =
        "display:block;width:100%;text-align:left;padding:6px 8px;margin-bottom:6px;" +
        "border:1px solid #ccc;border-radius:4px;background:#fafafa;cursor:pointer;";
      btn.addEventListener("click", function () {
        clearPicker();
        onPick(gift.variantId);
      });
      pickerRoot.appendChild(btn);
    });
    document.body.appendChild(pickerRoot);
  }

  function sync() {
    if (syncing) return;
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
        var addedRuleVariant = {};
        giftLines.forEach(function (line) {
          addedRuleVariant[line.properties[PROPERTY_KEY]] = line;
        });

        var staleLines = giftLines.filter(function (line) {
          var ruleId = findRuleIdForVariant(data.result.qualifying, line.properties[PROPERTY_KEY]);
          return !ruleId || qualifyingRuleIds.indexOf(ruleId) === -1;
        });

        var toRemove = staleLines.slice();
        var toAdd = null;
        var showPickerFor = null;

        data.result.qualifying.forEach(function (q) {
          var alreadyHasOne = q.gifts.some(function (g) {
            return giftLines.some(function (line) {
              return line.variant_id === Number(g.variantId.split("/").pop());
            });
          });
          if (alreadyHasOne) return;
          if (q.gifts.length === 1) {
            toAdd = q.gifts[0].variantId;
          } else if (!showPickerFor) {
            showPickerFor = q;
          }
        });

        var chain = Promise.resolve();
        toRemove.forEach(function (line) {
          chain = chain.then(function () {
            return removeLine(line);
          });
        });
        if (toAdd) {
          chain = chain.then(function () {
            return addGift(toAdd);
          });
        }
        return chain.then(function () {
          return { changed: toRemove.length > 0 || !!toAdd, showPickerFor: showPickerFor };
        });
      })
      .then(function (outcome) {
        syncing = false;
        if (outcome.showPickerFor) {
          showPicker(outcome.showPickerFor, function (variantId) {
            addGift(variantId).then(sync);
          });
        } else {
          clearPicker();
        }
        if (outcome.changed) {
          document.dispatchEvent(new CustomEvent("cartpromo:gift-sync"));
        }
      })
      .catch(function () {
        syncing = false;
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
    if (isCartMutation && !syncing) {
      result.then(function () {
        debouncedSync();
      });
    }
    return result;
  };

  document.addEventListener("cart:updated", debouncedSync);
  document.addEventListener("cart:refresh", debouncedSync);
  document.addEventListener("DOMContentLoaded", sync);
  if (document.readyState !== "loading") sync();
})();
