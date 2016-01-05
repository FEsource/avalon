var rinexpr = /^\s*([\s\S]+) in (\w+)/
var rkeyvalue = /\(\s*(\w+)\s*,\s*(\w+)\s*\)/
var rremoveRepeat = /^ms-(repeat|each)/
avalon.directive("repeat", {
    is: function (a, b) {
        if (Array.isArray(a)) {
            if (!Array.isArray(b)) {
                return false
            }
            if (a.length !== b.length) {
                return false
            }
            return !a.some(function (el, i) {
                return el !== b[i]
            })
        } else {
            return compareObject(a, b)
        }
    },
    init: function (binding) {
        //尝试使用ng风格的 el in array或(index, el) in array
        var expr = binding.expr, match
        if (match = expr.match(rinexpr)) {
            binding.expr = match[2]
            var keyvalue = match[1]
            if (match = keyvalue.match(rkeyvalue)) {
                binding.keyName = match[1]
                binding.valueName = match[2]
            } else {
                binding.valueName = keyvalue
            }
        }

        var vnode = binding.element
        disposeVirtual(vnode.children)
        var component = new VComponent("ms-repeat")
        var template = toString(vnode, rremoveRepeat) //防止死循环
        var type = binding.type
        var top = binding.vmodel, $outer = {}
        var signature = generateID(type)
        component.signature = signature
        //处理渲染完毕后的回调的函数
        var rendered = getBindingValue(vnode, "data-" + type + "-rendered", top)
        if (typeof rendered === "function") {
            binding.rendered = function (a, b, c) {
                rendered(type === "repeat" ? c : a)
            }
        } else {
            binding.rendered = noop
        }


        if (type === "repeat") {
            // repeat组件会替换旧原来的VElement
            var arr = binding.siblings
            for (var i = 0, el; el = arr[i]; i++) {
                if (el === vnode) {
                    arr[i] = component
                    break
                }
            }
            component.template = template + "<!--" + signature + "-->"
        } else {
            //each组件会替换掉原VComponent组件的所有孩子
            disposeVirtual(vnode.children)
            pushArray(vnode.children, [component])
            component.template = vnode.template.trim() + "<!--" + signature + "-->"
        }
//        component.item = createVirtual(component.template, true)
//        console.log(component.item)
        binding.element = component //偷龙转风
        //计算上级循环的$outer
        //外层vmodel不存在$outer对象时, $outer为一个空对象
        if (top.hasOwnProperty("$outer") && typeof top.$outer === "object" && top.$outer.names) {
            top.$outer.names.replace(rword, function (name) {
                if (top.hasOwnProperty(name)) {
                    $outer[name] = top[name]
                }
            })
        }
        binding.$outer = $outer
        delete binding.siblings
    },
    change: function (value, binding) {
        var vnode = binding.element
        if (!vnode || vnode.disposed) {
            return
        }
        var cache = binding.cache || {}
        var newCache = {}, children = [], keys = [], command = {}, last, proxy
        //处理valueName, keyName, last
        var repeatArray = Array.isArray(value)

        if (repeatArray) {
            last = value.length - 1
            if (!binding.valueName) {
                binding.valueName = binding.param || "el"
                delete binding.param
            }
            if (!binding.keyName) {
                binding.keyName = "$index"
            }
        } else {
            if (!binding.keyName) {
                binding.keyName = "$key"
            }
            if (!binding.valueName) {
                binding.valueName = "$val"
            }
            for (var k in value) {
                if (value.hasOwnProperty(k)) {
                    keys.push(k)
                }
            }
            last = keys.length - 1
        }
        //处理$outer.names
        if (!binding.$outer.names) {
            var names = ["$first", "$last", "$index", "$outer"]
            if (repeatArray) {
                names.push("$remove")
            }
            avalon.Array.ensure(names, binding.valueName)
            avalon.Array.ensure(names, binding.keyName)
            binding.$outer.names = names.join(",")
        }
        //用于存放新组件的位置
        var pos = []
        //键值如果为数字,表示它将移动到哪里,-1表示它将移除,-2表示它将创建
        //只遍历一次算出所有要更新的步骤 O(n) ,比kMP (O(m+n))快
        var subComponents = {}
        for (var i = 0; i <= last; i++) {
            if (repeatArray) {//如果是数组,以$id或type+值+"_"为键名
                var item = value[i]
                var component = isInCache(cache, item)//从缓存取出立即删掉
            } else {//如果是对象,直接用key为键名
                var key = keys[i]
                item = value[key]
                component = cache[key]
                delete cache[key]
            }
            if (component) {
                proxy = component.vmodel
                command[proxy.$index] = i//标识其从什么位置移动什么位置
            } else {//如果不存在就创建 
                component = new VComponent("repeatItem")
                component.template = vnode.template
                component.construct(item, binding, repeatArray)
                proxy = component.vmodel
                proxy.$outer = binding.$outer
                proxy[binding.keyName] = key || i
                proxy[binding.valueName] = item
                if (repeatArray) {
                    /* jshint ignore:start */
                    (function (array, el) {
                        proxy.$remove = function () {
                            avalon.Array.remove(array, el)
                        }
                    })(value, item)
                    /* jshint ignore:end */
                }
                command[i] = -2
                pos.push(i)
            }
            subComponents[i] = component
            proxy.$index = i
            proxy.$first = i === 0
            proxy.$last = i === last
            if (component._new) {
                updateVirtual(component.children, proxy)
                delete component._new
            }
            if (repeatArray) {
                saveInCache(newCache, item, component)
            } else {
                newCache[key] = component
            }
            children.push(component)
        }
        for (i in cache) {
            if (cache[i]) {
                var ii = cache[i].vmodel.$index
                var num = pos.shift()
                command[ii] = typeof num === "number" ? num : -1
                //如果这个位置被新虚拟节点占领了，那么我们就不用移除其对应的真实节点
                //但对应的旧虚拟节点还是要销毁的
                cache[i].dispose()
                delete cache[i]
            }
        }
        var vChildren = vnode.children

        vnode.subComponents = subComponents
        vChildren.length = 0
        pushArray(vChildren, children)
        vChildren.unshift(new VComment(vnode.signature + ":start"))
        vChildren.push(new VComment(vnode.signature + ":end"))
        binding.cache = newCache
        if (repeatArray) {
            binding.oldValue = value.concat()
        } else {
            binding.oldValue = newCache
        }
        vnode.repeatCommand = command

        addHook(vnode, binding.rendered, "afterChange", 95)
        addHooks(this, binding)
    },
    update: function (node, vnode, parent) {
        console.log(node, vnode.repeatCommand)
        if (!vnode.disposed) {
            var groupText = vnode.signature
            var nodeValue = node.nodeValue
            if (node.nodeType === 8 && /\w+\d+\:start/.test(nodeValue) &&
                    nodeValue !== groupText + ":start"
                    ) {
                updateSignature(node, nodeValue, groupText)

            }

            if (node.nodeType !== 8 || node.nodeValue !== groupText + ":start") {
                var dom = vnode.toDOM()
                var keepChild = avalon.slice(dom.childNodes)
                if (groupText.indexOf("each") === 0) {
                    avalon.clearHTML(parent)
                    parent.appendChild(dom)
                } else {
                    parent.removeChild(node.nextSibling)
                    parent.replaceChild(dom, node)
                }
                updateEntity(keepChild, getRepeatChild(vnode.children), parent)
                return false
            } else {

                var breakText = groupText + ":end"
                var fragment = document.createDocumentFragment()
                //将原有节点移出DOM, 试根据groupText分组
                var froms = {}, index = 0, next
                while (next = node.nextSibling) {
                    if (next.nodeValue === breakText) {
                        break
                    } else if (next.nodeValue === groupText) {
                        fragment.appendChild(next)
                        froms[index] = fragment
                        index++
                        fragment = document.createDocumentFragment()
                    } else {
                        fragment.appendChild(next)
                    }
                }
                //根据repeatCommand指令进行删增重排
                //console.log(vnode.repeatCommand)
                var children = []
                for (var from in vnode.repeatCommand) {
                    var to = vnode.repeatCommand[from]
                    if (to >= 0) {
                        children[to] = froms[from]
                    } else if (to < -1) {//-2 
                        //数量不足
                        children[from] = vnode.subComponents[from].toDOM()
                    }
                }

                fragment = document.createDocumentFragment()
                for (var i = 0, el; el = children[i++]; ) {
                    fragment.appendChild(el)
                }

                var entity = avalon.slice(fragment.childNodes)
                parent.insertBefore(fragment, node.nextSibling)
                var virtual = []
                vnode.children.forEach(function (el) {
                    pushArray(virtual, el.children)
                })
                updateEntity(entity, virtual, parent)
                return false
            }
        }
        return false
    },
    old: function (binding, oldValue) {
        if (!Array.isArray(oldValue)) {
            var o = binding.oldValue = {}
            for (var i in oldValue) {
                if (oldValue.hasOwnProperty(i)) {
                    o[i] = oldValue[i]
                }
            }
        }
    }
})
function cloneNodes(array) {
    var ret = []
    for (var i = 0, el; el = array[i]; i++) {
        var type = getVType(el)
        if (type === 1) {
            var clone = new VElement(el.type, avalon.mix({}, el.props), cloneNodes(el.children))
            clone.template = el.template
            ret[i] = clone
        } else if (type === 3) {
            ret[i] = new VText(el.nodeValue)
        } else if (type === 8) {
            ret[i] = new VComment(el.nodeValue)
        }
    }
    return ret
}
function updateSignature(elem, value, text) {
    var group = value.split(":")[0]
    do {
        var nodeValue = elem.nodeValue
        if (elem.nodeType === 8 && nodeValue.indexOf(group) === 0) {
            elem.nodeValue = nodeValue.replace(group, text)
            if (nodeValue.indexOf(":last") > 0) {
                break
            }
        }
    } while (elem = elem.nextSibling)
}

var repeatItem = avalon.components["repeatItem"] = {
    construct: function (item, binding, repeatArray) {
        var top = binding.vmodel
        if (item && item.$id) {
            top = createProxy(top, item)
        }
        var keys = [binding.keyName, binding.valueName, "$index", "$first", "$last"]
        this.valueName = binding.valueName
        var proxy = createRepeatItem(top, keys, repeatArray)
        this.vmodel = proxy
        this.children = createVirtual(this.template, true)
        this._new = true
        this.dispose = repeatItem.dispose
        return this
    },
    dispose: function () {
        disposeVirtual([this])
        var proxy = this.vmodel
        var item = proxy[this.valueName]
        proxy && (proxy.$active = false)
        if (item && item.$id) {
            item.$active = false
        }
    }
}



function createRepeatItem(before, keys, repeatArray) {
    var heirloom = {}
    var after = {
        $accessors: {},
        $outer: 1
    }
    for (var i = 0, key; key = keys[i++]; ) {
        after.$accessors[key] = makeObservable(key, heirloom)
    }
    if (repeatArray) {
        after.$remove = noop
    }
    if (Object.defineProperties) {
        Object.defineProperties(after, after.$accessors)
    }

    return createProxy(before, after, heirloom)
}

function getRepeatChild(children) {
    var ret = []
    for (var i = 0, el; el = children[i++]; ) {
        if (el.__type__ === "repeatItem") {
            pushArray(ret, el.children)
        } else {
            ret.push(el)
        }
    }
    return ret
}

avalon.directives.each = avalon.directives.repeat
avalon.components["ms-each"] = avalon.components["ms-repeat"]


function compareObject(a, b) {
    var atype = avalon.type(a)
    var btype = avalon.type(a)
    if (atype === btype) {
        var aisVM = atype === "object" && a.$id
        var bisVM = btype === "object"
        var hasDetect = {}
        if (aisVM && bisVM) {
            for (var i in a) {
                hasDetect[i] = true
                if ($$skipArray[i])
                    continue
                if (a.hasOwnProperty(i)) {
                    if (!b.hasOwnProperty(i))
                        return false //如果a有b没有
                    if (!compareObject(a[i], b[i]))
                        return false
                }
            }
            for (i in b) {
                if (hasDetect[i]) {
                    continue
                }//如果b有a没有
                return false
            }
            return true
        } else {
            if (btype === "date")
                return a + 0 === b + 0
            return a === b
        }
    } else {
        return false
    }
}

function isInCache(cache, vm) {
    var isObject = Object(vm) === vm, c
    if (isObject) {
        c = cache[vm.$id]
        if (c) {
            delete cache[vm.$id]
        }
        return c
    } else {
        var id = avalon.type(vm) + "_" + vm
        c = cache[id]
        if (c) {
            var stack = [{id: id, c: c}]
            while (1) {
                id += "_"
                if (cache[id]) {
                    stack.push({
                        id: id,
                        c: cache[id]
                    })
                } else {
                    break
                }
            }
            var a = stack.pop()
            delete cache[a.id]
            return a.c
        }
        return c
    }
}

function saveInCache(cache, vm, component) {
    if (Object(vm) === vm) {
        cache[vm.$id] = component
    } else {
        var type = avalon.type(vm)
        var trackId = type + "_" + vm
        if (!cache[trackId]) {
            cache[trackId] = component
        } else {
            while (1) {
                trackId += "_"
                if (!cache[trackId]) {
                    cache[trackId] = component
                    break
                }
            }
        }
    }
}