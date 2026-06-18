package com.inkforge.localplay

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import fi.iki.elonen.NanoWSD.WebSocket
import fi.iki.elonen.NanoWSD.WebSocketFrame
import java.io.IOException
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.ArrayDeque
import java.util.Collections

/**
 * Local-network play (spec §8, revised): zero-config discovery + direct
 * connection on the shared network. The host runs a NanoHTTPD WebSocket server
 * and advertises it via Android NSD; followers browse NSD and connect with a
 * plain WebSocket. Messages bridge to JS via plugin events.
 */
@CapacitorPlugin(name = "LocalNet")
class LocalNetPlugin : Plugin() {

    private val serviceType = "_inkforge._tcp."
    private var nsdManager: NsdManager? = null
    private var server: WsServer? = null
    private var regListener: NsdManager.RegistrationListener? = null
    private var discListener: NsdManager.DiscoveryListener? = null
    private var multicastLock: WifiManager.MulticastLock? = null

    // NSD resolve is single-flight on older Android; serialize requests.
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false

    private fun emit(event: String, data: JSObject = JSObject()) {
        activity?.runOnUiThread { notifyListeners(event, data) }
    }

    /** Surface a native-side diagnostic to JS (shown in the in-app connection log). */
    private fun log(msg: String, level: String = "info") {
        val o = JSObject()
        o.put("level", level)
        o.put("msg", msg)
        emit("log", o)
    }

    /** Human-readable NSD error code (Android constants are bare ints otherwise). */
    private fun nsdErr(code: Int): String = when (code) {
        NsdManager.FAILURE_ALREADY_ACTIVE -> "ALREADY_ACTIVE"
        NsdManager.FAILURE_INTERNAL_ERROR -> "INTERNAL_ERROR"
        NsdManager.FAILURE_MAX_LIMIT -> "MAX_LIMIT"
        else -> "code $code"
    }

    private fun nsd(): NsdManager =
        (context.getSystemService(Context.NSD_SERVICE) as NsdManager).also { nsdManager = it }

    /** Non-loopback IPv4 addresses of this device (for display + manual connect). */
    private fun localIpv4(): List<String> {
        val out = mutableListOf<String>()
        try {
            for (nif in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in Collections.list(nif.inetAddresses)) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress) addr.hostAddress?.let { out.add(it) }
                }
            }
        } catch (_: Exception) {}
        return out
    }

    /** Prefer an IPv4 host address (avoids unroutable IPv6/link-local in ws URLs). */
    private fun pickHost(si: NsdServiceInfo): String {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                val list = si.hostAddresses
                (list.firstOrNull { it is Inet4Address } ?: list.firstOrNull())?.let { return it.hostAddress ?: "" }
            }
        } catch (_: Exception) {}
        @Suppress("DEPRECATION")
        return si.host?.hostAddress ?: ""
    }

    // ---- Host ----

    @PluginMethod
    fun startHost(call: PluginCall) {
        val name = call.getString("name") ?: "Lorcana game"
        try {
            val srv = WsServer(0)
            srv.start(0, true)
            val port = srv.listeningPort
            server = srv
            registerService(name, port)
            val ret = JSObject()
            ret.put("port", port)
            ret.put("name", name)
            val addrs = JSArray()
            for (ip in localIpv4()) addrs.put(ip)
            ret.put("addresses", addrs)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("startHost failed: ${e.message}")
        }
    }

    private fun registerService(name: String, port: Int) {
        val info = NsdServiceInfo().apply {
            serviceName = name
            serviceType = this@LocalNetPlugin.serviceType
            setPort(port)
            // Advertise every local IPv4 so a follower on a multi-homed host can
            // try each interface (hotspot vs. VPN/cellular) and reach a live one.
            try { setAttribute("ips", localIpv4().joinToString(",")) } catch (_: Exception) {}
        }
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(arg0: NsdServiceInfo) { log("NSD advertised as \"${arg0.serviceName}\" on port $port") }
            override fun onRegistrationFailed(arg0: NsdServiceInfo, errorCode: Int) { log("NSD registration FAILED (${nsdErr(errorCode)}) — followers won't discover this host; use Connect by IP", "error") }
            override fun onServiceUnregistered(arg0: NsdServiceInfo) {}
            override fun onUnregistrationFailed(arg0: NsdServiceInfo, errorCode: Int) {}
        }
        regListener = listener
        nsd().registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    @PluginMethod
    fun stopHost(call: PluginCall) {
        try { regListener?.let { nsdManager?.unregisterService(it) } } catch (_: Exception) {}
        regListener = null
        server?.stop()
        server = null
        call.resolve()
    }

    @PluginMethod
    fun send(call: PluginCall) {
        server?.broadcast(call.getString("data") ?: "")
        call.resolve()
    }

    // ---- Discovery (follower) ----

    @PluginMethod
    fun startDiscovery(call: PluginCall) {
        try {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val lock = wifi.createMulticastLock("inkforge-nsd").apply { setReferenceCounted(true); acquire() }
            multicastLock = lock
        } catch (_: Exception) {}

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) { log("discovery started for $serviceType") }
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { log("discovery FAILED to start (${nsdErr(errorCode)})", "error") }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceFound(service: NsdServiceInfo) { log("found service \"${service.serviceName}\", resolving…"); queueResolve(service) }
            override fun onServiceLost(service: NsdServiceInfo) {
                log("service lost: \"${service.serviceName}\"", "warn")
                val o = JSObject(); o.put("name", service.serviceName); emit("peerLost", o)
            }
        }
        discListener = listener
        try {
            nsd().discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
            call.resolve()
        } catch (e: Exception) {
            call.reject("discovery failed: ${e.message}")
        }
    }

    private fun queueResolve(service: NsdServiceInfo) {
        synchronized(resolveQueue) {
            resolveQueue.add(service)
            if (!resolving) resolveNext()
        }
    }

    private fun resolveNext() {
        val service: NsdServiceInfo
        synchronized(resolveQueue) {
            if (resolveQueue.isEmpty()) { resolving = false; return }
            resolving = true
            service = resolveQueue.poll()
        }
        val manager = nsdManager ?: return
        val resolveListener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                log("resolve FAILED for \"${serviceInfo.serviceName}\" (${nsdErr(errorCode)})", "warn")
                synchronized(resolveQueue) { resolving = false }
                resolveNext()
            }
            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val host = pickHost(serviceInfo)
                // Collect every candidate address: the advertised "ips" attribute
                // (all host interfaces) plus whatever NSD resolved.
                val cand = LinkedHashSet<String>()
                if (host.isNotEmpty()) cand.add(host)
                try {
                    serviceInfo.attributes?.get("ips")?.let { String(it).split(",") }?.forEach { ip ->
                        ip.trim().takeIf { it.isNotEmpty() }?.let { cand.add(it) }
                    }
                } catch (_: Exception) {}
                try {
                    if (Build.VERSION.SDK_INT >= 34) serviceInfo.hostAddresses.forEach { a -> a.hostAddress?.let { cand.add(it) } }
                } catch (_: Exception) {}
                log("resolved \"${serviceInfo.serviceName}\" -> ${cand.joinToString(", ")}:${serviceInfo.port}")
                val o = JSObject()
                o.put("name", serviceInfo.serviceName)
                o.put("host", host)
                o.put("port", serviceInfo.port)
                val addrs = JSArray()
                for (ip in cand) addrs.put(ip)
                o.put("addresses", addrs)
                emit("peerFound", o)
                synchronized(resolveQueue) { resolving = false }
                resolveNext()
            }
        }
        try {
            manager.resolveService(service, resolveListener)
        } catch (_: Exception) {
            synchronized(resolveQueue) { resolving = false }
            resolveNext()
        }
    }

    @PluginMethod
    fun stopDiscovery(call: PluginCall) {
        try { discListener?.let { nsdManager?.stopServiceDiscovery(it) } } catch (_: Exception) {}
        discListener = null
        try { multicastLock?.release() } catch (_: Exception) {}
        multicastLock = null
        call.resolve()
    }

    // ---- WebSocket server ----

    inner class WsServer(port: Int) : NanoWSD(port) {
        @Volatile
        var socket: WebSocket? = null

        override fun openWebSocket(handshake: NanoHTTPD.IHTTPSession): WebSocket {
            return object : WebSocket(handshake) {
                override fun onOpen() {
                    socket = this
                    log("WebSocket server accepted a follower connection")
                    emit("peerConnected")
                }
                override fun onClose(code: WebSocketFrame.CloseCode?, reason: String?, initiatedByRemote: Boolean) {
                    socket = null
                    log("WebSocket server connection closed (${code?.name ?: "?"}${if (reason.isNullOrEmpty()) "" else ", \"$reason\""}, ${if (initiatedByRemote) "by remote" else "by host"})", "warn")
                    emit("peerDisconnected")
                }
                override fun onMessage(message: WebSocketFrame) {
                    val o = JSObject()
                    o.put("data", message.textPayload)
                    emit("message", o)
                }
                override fun onPong(pong: WebSocketFrame) {}
                override fun onException(exception: IOException) { log("WebSocket server exception: ${exception.message}", "error") }
            }
        }

        fun broadcast(text: String) {
            try { socket?.send(text) } catch (_: IOException) {}
        }
    }
}
